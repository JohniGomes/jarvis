"""Robô sob demanda: lê a tabela "Escalas" do Gestor de Escalas (todas as
regiões/turnos de hoje, sem filtro de CPF) e grava o preenchimento de vagas
no Supabase, pra alimentar o card "Preenchimento de vagas" na aba Análise.

Disparado pelo botão "Atualizar" do painel (via Edge Function
escalas-refresh, que aciona esse workflow por workflow_dispatch) -- não
tem cron, é sempre sob demanda.

Uso: python -m robots.escalas_vagas
"""
import os
import re
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.browser_launch import launch_browser
from robots.franqueado_login import login as franqueado_login

load_dotenv()

SHIFT_SCHEDULE_URL = "https://franqueado.entregolog.com/supply/logistic-operator/shift-schedule"
MAX_TENTATIVAS = 6
MAX_PAGINAS = 25  # trava de segurança -- viu-se 17 páginas em teste real

BRASILIA_TZ = ZoneInfo("America/Sao_Paulo")


def agora_brasilia():
    return datetime.now(BRASILIA_TZ)


def log(msg):
    print(f"[{agora_brasilia().strftime('%H:%M:%S')}] {msg}", flush=True)


def _supa_headers():
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    return url, {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def automacao_ligada(url, headers):
    r = requests.get(
        f"{url}/rest/v1/automacao_config?chave=eq.chatwoot_bot&select=ativo",
        headers=headers, timeout=15,
    )
    r.raise_for_status()
    linhas = r.json()
    if not linhas:
        return True
    return linhas[0]["ativo"] is not False


_HORARIO_RE = re.compile(r"(\d{1,2})H(\d{2})-(\d{1,2})H(\d{2})", re.IGNORECASE)
_QTD_RE = re.compile(r"^(\d+)/(\d+)$")


def _ultima_linha_nao_vazia(texto):
    linhas = [l.strip() for l in texto.split("\n") if l.strip()]
    return linhas[-1] if linhas else ""


def _parsear_linha(texto_linha):
    """texto_linha vem de <tr>.inner_text() -- colunas irmãs (<td>) são
    separadas por TAB; dentro de uma célula multi-linha (Área ou Origem,
    Modal) o conteúdo interno vem separado por \\n. Ver teste real
    12/08/2026 que confirmou esse formato exato:
    '12/08/2026\\tMADRUGADA 00H00-00H59\\t\\nSubPraça\\nTATUAPE - SP\\n\\t\\nMOTORCYCLE\\n\\t0/10\\t0/0\\tTodos\\t'
    """
    cols = texto_linha.split("\t")
    if len(cols) < 6:
        return None

    data_str = cols[0].strip()
    turno_str = cols[1].strip()
    area_str = _ultima_linha_nao_vazia(cols[2])  # ignora a badge "SubPraça"
    modal_str = _ultima_linha_nao_vazia(cols[3])
    regular_str = cols[4].strip()
    excesso_str = cols[5].strip()

    try:
        data_turno = datetime.strptime(data_str, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return None

    m_regular = _QTD_RE.match(regular_str)
    if not m_regular:
        return None
    regular_preenchido, regular_total = int(m_regular.group(1)), int(m_regular.group(2))

    m_excesso = _QTD_RE.match(excesso_str)
    excesso_preenchido = int(m_excesso.group(1)) if m_excesso else 0
    excesso_total = int(m_excesso.group(2)) if m_excesso else 0

    return {
        "data": data_turno,
        "turno": turno_str,
        "area_origem": area_str,
        "modal": modal_str,
        "regular_preenchido": regular_preenchido,
        "regular_total": regular_total,
        "excesso_preenchido": excesso_preenchido,
        "excesso_total": excesso_total,
    }


def ler_todas_as_escalas(page):
    page.goto(SHIFT_SCHEDULE_URL)
    page.wait_for_timeout(2000)

    registros = []
    pagina = 1
    while True:
        linhas = page.locator("table tbody tr")
        total_pagina = linhas.count()
        for i in range(total_pagina):
            texto = linhas.nth(i).inner_text()
            registro = _parsear_linha(texto)
            if registro is not None:
                registros.append(registro)

        proximo = page.get_by_role("button", name=re.compile("^Pr.ximo$", re.I))
        if proximo.count() == 0 or not proximo.first.is_enabled():
            break
        proximo.first.click()
        page.wait_for_timeout(1000)
        pagina += 1
        if pagina > MAX_PAGINAS:
            log(f"Atingiu o limite de segurança de {MAX_PAGINAS} páginas -- parando.")
            break

    log(f"{len(registros)} linha(s) de escala lida(s) em {pagina} página(s).")
    return registros


def _ler_com_retry(p):
    ultimo_erro = None
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        page.set_default_navigation_timeout(60000)
        page.set_default_timeout(45000)
        try:
            log("Login em franqueado.entregolog.com...")
            franqueado_login(page)
            log("Lendo tabela de Escalas...")
            registros = ler_todas_as_escalas(page)
            browser.close()
            if not registros:
                raise RuntimeError("Nenhuma linha de escala foi lida -- provavelmente a página não carregou direito, não vale a pena gravar vazio.")
            return registros
        except Exception as e:
            ultimo_erro = e
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS} falhou: {type(e).__name__}: {e}")
            try:
                page.screenshot(path=f"robots/debug_escalas_vagas_tentativa{tentativa}.png", full_page=True, timeout=5000)
            except Exception:
                pass
            browser.close()
            if tentativa < MAX_TENTATIVAS:
                time.sleep(15)
    raise ultimo_erro


def salvar_no_supabase(url, headers, registros):
    agora_iso = agora_brasilia().isoformat()
    for registro in registros:
        registro["sincronizado_em"] = agora_iso

    data_hoje = agora_brasilia().date().isoformat()
    # Substitui inteiro o snapshot do dia -- não é incremental, cada
    # sincronização reflete o estado atual completo do gestor de escalas.
    r = requests.delete(
        f"{url}/rest/v1/escalas_vagas?data=eq.{data_hoje}",
        headers={**headers, "Prefer": "return=minimal"},
        timeout=15,
    )
    r.raise_for_status()

    r = requests.post(
        f"{url}/rest/v1/escalas_vagas",
        headers={**headers, "Prefer": "return=minimal"},
        json=registros,
        timeout=30,
    )
    r.raise_for_status()


def main():
    url, headers = _supa_headers()

    if not automacao_ligada(url, headers):
        log("Automação desligada no painel (automacao_config) -- não processa.")
        return

    with sync_playwright() as p:
        registros = _ler_com_retry(p)

    log("Gravando no Supabase...")
    salvar_no_supabase(url, headers, registros)
    log("Concluído.")


if __name__ == "__main__":
    main()
