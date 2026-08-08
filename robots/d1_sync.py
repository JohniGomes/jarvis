"""Robo diario: baixa o relatorio de Performance (D-1) de ontem no
franqueado.entregolog.com e faz upsert na tabela d1_rows do Supabase.

Uso local: python -m robots.d1_sync
"""
import csv
import io
import os
import re
import time
import zipfile
from datetime import date, datetime, timedelta

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

from robots.browser_launch import launch_browser
from robots.franqueado_login import login

# No GitHub Actions as variáveis já vêm como Secrets reais -- load_dotenv()
# não encontra ".env" lá e simplesmente não faz nada. Rodando local (tarefa
# agendada), lê o ".env" na raiz do repo.
load_dotenv()

RELATORIO_TIPO = "Performance"


def log(msg):
    print(msg, flush=True)


def _selecionar_dia_calendario(page, label, data_alvo):
    page.get_by_label(label).first.click()
    page.wait_for_timeout(300)
    dia = str(data_alvo.day)
    page.get_by_text(re.compile(rf"^{dia}$")).first.click()
    page.wait_for_timeout(300)


def _wait_networkidle_soft(page):
    # Através do proxy residencial, "networkidle" às vezes nunca chega
    # (analytics/PerimeterX mandando requisição em loop de fundo) -- só
    # tenta esperar, sem travar o fluxo se estourar o tempo; os cliques
    # seguintes já esperam o elemento ficar visível/clicável sozinhos.
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass


def gerar_e_baixar(page, data_inicio, data_fim, destino):
    # login() já deixa a página carregada (URL final .../supply/driver-booking-import,
    # mesma SPA) -- recarregar tudo de novo com page.goto força um reload
    # completo do bundle JS (incluindo o desafio anti-bot do PerimeterX de
    # novo), que via proxy trava com muita frequência. Navega pelo menu a
    # partir de onde já está, sem reload.
    expandir = page.get_by_role("button", name="Expandir")
    if expandir.count() > 0:
        expandir.click()
        page.wait_for_timeout(1000)
    page.get_by_text("Operador logístico", exact=False).first.click()
    page.wait_for_timeout(500)
    page.get_by_text("Relatórios", exact=False).first.click()
    _wait_networkidle_soft(page)

    page.get_by_text("Selecione", exact=True).first.click()
    # Via proxy/nuvem o dropdown pode demorar um pouco mais pra abrir e
    # popular as opções -- sem esse wait, o click seguinte às vezes procura
    # a opção antes dela existir no DOM.
    page.wait_for_timeout(800)
    page.get_by_role("option", name=re.compile(RELATORIO_TIPO, re.I)).click()

    _selecionar_dia_calendario(page, "Data início", data_inicio)
    _selecionar_dia_calendario(page, "Data fim", data_fim)

    with page.expect_download(timeout=90000) as download_info:
        page.get_by_role("button", name=re.compile("Gerar Relat.rio", re.I)).click()
    download_info.value.save_as(destino)


def ler_bundle(caminho_zip):
    with zipfile.ZipFile(caminho_zip) as z:
        linhas = []
        for nome in z.namelist():
            with z.open(nome) as f:
                texto = io.TextIOWrapper(f, encoding="utf-8-sig")
                for row in csv.DictReader(texto, delimiter=";"):
                    linhas.append(row)
        return linhas


def transformar(linhas_csv):
    # tag/praca/origem/soma_das_taxas_das_corridas_aceitas vêm no CSV mas
    # nunca são lidos pelo painel (confirmado por grep no index.html) -- por
    # isso simplesmente não entram no dict de saída abaixo.
    out = []
    for r in linhas_csv:
        if not r.get("data_do_periodo") or not r.get("pessoa_entregadora"):
            continue
        out.append({
            "data_do_periodo": r["data_do_periodo"],
            "periodo": r["periodo"],
            "duracao_do_periodo": r.get("duracao_do_periodo") or None,
            "numero_minimo_de_entregadores_regulares_na_escala": _num(r.get("numero_minimo_de_entregadores_regulares_na_escala")),
            "id_da_pessoa_entregadora": r.get("id_da_pessoa_entregadora") or None,
            "pessoa_entregadora": r["pessoa_entregadora"],
            "sub_praca": r.get("sub_praca") or None,
            "tempo_disponivel_escalado": _num(r.get("tempo_disponivel_escalado")),
            "tempo_disponivel_absoluto": r.get("tempo_disponivel_absoluto") or None,
            "numero_de_corridas_ofertadas": _num(r.get("numero_de_corridas_ofertadas")) or 0,
            "numero_de_corridas_aceitas": _num(r.get("numero_de_corridas_aceitas")) or 0,
            "numero_de_corridas_rejeitadas": _num(r.get("numero_de_corridas_rejeitadas")) or 0,
            "numero_de_corridas_completadas": _num(r.get("numero_de_corridas_completadas")) or 0,
            "numero_de_corridas_canceladas_pela_pessoa_entregadora": _num(r.get("numero_de_corridas_canceladas_pela_pessoa_entregadora")) or 0,
            "numero_de_pedidos_aceitos_e_concluidos": _num(r.get("numero_de_pedidos_aceitos_e_concluidos")) or 0,
        })
    return out


def _num(val):
    if val is None or val == "":
        return None
    try:
        return float(val)
    except ValueError:
        return None


def _dedupe(linhas):
    # Mesma chave natural da tabela -- o relatório pode trazer a mesma linha
    # mais de uma vez (mesmo comportamento visto na planilha antiga); sem
    # isso o upsert falha porque duas linhas do mesmo lote colidem no mesmo
    # ON CONFLICT.
    por_chave = {}
    for r in linhas:
        chave = (r["data_do_periodo"], r["periodo"], r["id_da_pessoa_entregadora"] or "", r["sub_praca"] or "")
        por_chave[chave] = r
    return list(por_chave.values())


def upsert_supabase(linhas):
    linhas = _dedupe(linhas)
    if not linhas:
        log("Nenhuma linha no relatório -- nada pra enviar.")
        return
    # .strip() -- segredos colados em GitHub Actions Secrets às vezes
    # carregam uma quebra de linha/espaço a mais, o que vira um
    # InvalidHeader na hora de montar o Authorization.
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    # D-1 é histórico cumulativo (não substitui o dia todo como o Sem
    # Corridas) -- upsert por chave natural, pra rodar de novo no mesmo dia
    # sem duplicar.
    chunk_size = 500
    for i in range(0, len(linhas), chunk_size):
        chunk = linhas[i:i + chunk_size]
        resp = requests.post(
            f"{url}/rest/v1/d1_rows?on_conflict=data_do_periodo,periodo,id_da_pessoa_entregadora,sub_praca",
            headers=headers, json=chunk, timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(f"Falha ao upsert em d1_rows (lote {i}-{i + len(chunk)}): {resp.status_code} {resp.text}")
    log(f"d1_rows: {len(linhas)} linhas enviadas.")


MAX_TENTATIVAS = 4


def ja_sincronizado(data_alvo):
    """Confere se já tem linha de d1_rows pra essa data -- usado pra deixar
    seguro rodar o sync mais de uma vez no mesmo dia (rede de segurança
    automática, ver cron extra em sync-d1.yml) sem refazer trabalho à toa
    quando o sync da manhã já deu certo."""
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    resp = requests.get(
        f"{url}/rest/v1/d1_rows?data_do_periodo=eq.{data_alvo.isoformat()}&select=id&limit=1",
        headers=headers, timeout=15,
    )
    resp.raise_for_status()
    return len(resp.json()) > 0


def main():
    # DATA_ALVO opcional (formato YYYY-MM-DD) -- pra rodar manualmente pra
    # um dia específico (ex.: recuperar um dia que falhou), sem depender
    # de "ontem" relativo a quando o robô roda.
    data_alvo_env = os.environ.get("DATA_ALVO", "").strip()
    if data_alvo_env:
        ontem = datetime.strptime(data_alvo_env, "%Y-%m-%d").date()
    else:
        hoje = date.today()
        ontem = hoje - timedelta(days=1)

    # Autorrecuperação: se já tem dado desse dia no banco (sync anterior deu
    # certo), não roda de novo -- só importa quando ISSO ainda está faltando,
    # o que permite agendar horários extras no dia como rede de segurança
    # sem gastar rodadas à toa quando está tudo ok.
    if ja_sincronizado(ontem):
        log(f"{ontem} já está sincronizado -- nada a fazer.")
        return

    destino = "robots/bundle_download.zip"

    # Via proxy residencial saindo do GitHub Actions, a conexão pode travar
    # em QUALQUER page.goto -- não só no login (já vimos falhar depois,
    # dentro de gerar_e_baixar). Por isso o retry envolve o fluxo inteiro
    # (login + gerar + baixar), sempre recriando o browser do zero a cada
    # tentativa, em vez de só proteger o login.
    ultimo_erro = None
    with sync_playwright() as p:
        for tentativa in range(1, MAX_TENTATIVAS + 1):
            browser = launch_browser(p.chromium)
            page = browser.new_page(accept_downloads=True)
            try:
                log("Login em franqueado.entregolog.com...")
                login(page)
                log(f"Gerando relatório Performance de {ontem}...")
                gerar_e_baixar(page, ontem, ontem, destino)
                browser.close()
                break
            except Exception as e:
                ultimo_erro = e
                log(f"Tentativa {tentativa}/{MAX_TENTATIVAS} falhou: {type(e).__name__}: {e}")
                try:
                    page.screenshot(path="robots/debug_d1_sync.png", full_page=True, timeout=5000)
                except Exception as screenshot_erro:
                    log(f"(não consegui tirar screenshot de erro: {screenshot_erro})")
                browser.close()
                if tentativa == MAX_TENTATIVAS:
                    raise ultimo_erro
                time.sleep(8)

    log("Lendo bundle...")
    linhas_csv = ler_bundle(destino)
    log(f"{len(linhas_csv)} linhas no CSV.")
    linhas = transformar(linhas_csv)
    upsert_supabase(linhas)


if __name__ == "__main__":
    main()
