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
from datetime import date, timedelta

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
    page.goto("https://franqueado.entregolog.com")
    _wait_networkidle_soft(page)

    expandir = page.get_by_role("button", name="Expandir")
    if expandir.count() > 0:
        expandir.click()
        page.wait_for_timeout(1000)
    page.get_by_text("Operador logístico", exact=False).first.click()
    page.wait_for_timeout(500)
    page.get_by_text("Relatórios", exact=False).first.click()
    _wait_networkidle_soft(page)

    page.get_by_text("Selecione", exact=True).first.click()
    page.get_by_role("option", name=re.compile(RELATORIO_TIPO, re.I)).click()

    _selecionar_dia_calendario(page, "Data início", data_inicio)
    _selecionar_dia_calendario(page, "Data fim", data_fim)

    with page.expect_download(timeout=60000) as download_info:
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


MAX_TENTATIVAS_LOGIN = 4


def _login_com_retry(p):
    # Via proxy residencial saindo do GitHub Actions, a conexão às vezes
    # trava/cai no meio do fluxo de login (instabilidade de rede, não bug
    # de timing) -- RECRIA o browser a cada tentativa (nova conexão TCP com
    # o proxy) em vez de insistir na mesma conexão travada.
    ultimo_erro = None
    for tentativa in range(1, MAX_TENTATIVAS_LOGIN + 1):
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        try:
            login(page)
            return browser, page
        except Exception as e:
            ultimo_erro = e
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS_LOGIN} de login falhou: {type(e).__name__}: {e}")
            browser.close()
            if tentativa < MAX_TENTATIVAS_LOGIN:
                time.sleep(8)
    raise ultimo_erro


def main():
    hoje = date.today()
    ontem = hoje - timedelta(days=1)
    destino = "robots/bundle_download.zip"

    with sync_playwright() as p:
        log("Login em franqueado.entregolog.com...")
        browser, page = _login_com_retry(p)
        try:
            log(f"Gerando relatório Performance de {ontem}...")
            gerar_e_baixar(page, ontem, ontem, destino)
        except Exception:
            page.screenshot(path="robots/debug_d1_sync.png", full_page=True)
            raise
        finally:
            browser.close()

    log("Lendo bundle...")
    linhas_csv = ler_bundle(destino)
    log(f"{len(linhas_csv)} linhas no CSV.")
    linhas = transformar(linhas_csv)
    upsert_supabase(linhas)


if __name__ == "__main__":
    main()
