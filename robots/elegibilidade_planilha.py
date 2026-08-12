"""Robô horário: baixa a planilha "Elegibilidade Jarvis" (Google Sheets,
já mantida atualizada por outro processo) e sobe direto pro franqueado
(driver-booking-import), substituindo a lista inteira de uma vez.

Decisão do usuário 10/08/2026: essa planilha passou a ser a ÚNICA fonte
de verdade da elegibilidade -- o sistema antigo (Liberar/Bloquear via
chat/painel, agendamento_watcher.py + agendamento_elegibilidade) foi
desativado pra não ter dois processos brigando pra decidir a lista final
(o upload sempre substitui tudo, não é incremental).

Uso: python -m robots.elegibilidade_planilha
"""
import os
import re
import sys
import time

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.browser_launch import launch_browser
from robots.franqueado_login import login as franqueado_login

load_dotenv()

SHEET_ID = "1DJoKoGGdeSceaQio64fdXNCoahoyJCQ_4zVG42L1XNA"
SHEET_GID = "1758304617"
SHEET_CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={SHEET_GID}"

MAX_TENTATIVAS = 6
UPLOAD_TMP_PATH = "robots/elegibilidade_upload_tmp.csv"


def log(msg):
    print(msg, flush=True)


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
        f"{url}/rest/v1/automacao_config?chave=eq.elegibilidade_planilha&select=ativo",
        headers=headers, timeout=15,
    )
    r.raise_for_status()
    linhas = r.json()
    if not linhas:
        return True  # sem linha configurada = comportamento padrão (ligado)
    return linhas[0]["ativo"] is not False


def baixar_planilha():
    resp = requests.get(SHEET_CSV_URL, timeout=30)
    resp.raise_for_status()
    texto = resp.text
    total_linhas = texto.count("\n")  # inclui o cabeçalho
    if total_linhas < 2:
        raise RuntimeError(f"Planilha vazia ou com poucas linhas ({total_linhas}) -- abortando pra não apagar a elegibilidade real por engano.")
    return texto, total_linhas - 1  # -1 pro cabeçalho


def _wait_networkidle_soft(page):
    # Via proxy residencial "networkidle" às vezes nunca chega (analytics/
    # PerimeterX em loop de fundo) -- não trava o fluxo se estourar.
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass


def enviar_csv_elegibilidade(page, csv_texto):
    with open(UPLOAD_TMP_PATH, "w", encoding="utf-8", newline="") as f:
        f.write(csv_texto)

    page.goto("https://franqueado.entregolog.com/supply/driver-booking-import")
    _wait_networkidle_soft(page)
    page.wait_for_timeout(800)
    page.get_by_role("radiogroup").get_by_text("Elegibilidade", exact=True).click()
    page.wait_for_timeout(800)

    file_input = page.locator("input[type=file]")
    file_input.set_input_files(UPLOAD_TMP_PATH)
    page.wait_for_timeout(800)

    botao_enviar = page.get_by_role("button", name=re.compile("^Enviar$", re.I))
    botao_enviar.wait_for(timeout=10000)
    botao_enviar.click()
    page.wait_for_timeout(3000)
    _wait_networkidle_soft(page)

    os.remove(UPLOAD_TMP_PATH)


def _enviar_com_retry(p, csv_texto):
    ultimo_erro = None
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        # Padrão do Playwright pra navegação (30s) estoura direto via proxy
        # residencial em horários de mais latência/congestionamento do
        # Akamai -- dá mais fôlego antes de desistir e cair pro retry.
        page.set_default_navigation_timeout(60000)
        page.set_default_timeout(45000)
        try:
            log("Login em franqueado.entregolog.com...")
            franqueado_login(page)
            log("Enviando planilha de elegibilidade...")
            enviar_csv_elegibilidade(page, csv_texto)
            browser.close()
            return
        except Exception as e:
            ultimo_erro = e
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS} falhou: {type(e).__name__}: {e}")
            try:
                page.screenshot(path=f"robots/debug_elegibilidade_tentativa{tentativa}.png", full_page=True, timeout=5000)
            except Exception:
                pass
            browser.close()
            if tentativa < MAX_TENTATIVAS:
                time.sleep(15)
    raise ultimo_erro


def main():
    url, headers = _supa_headers()

    if not automacao_ligada(url, headers):
        log("Automação desligada no painel (automacao_config) -- não processa.")
        return

    log("Baixando planilha Elegibilidade Jarvis...")
    csv_texto, total_linhas = baixar_planilha()
    log(f"{total_linhas} linhas de elegibilidade na planilha.")

    with sync_playwright() as p:
        _enviar_com_retry(p, csv_texto)

    log("Concluído.")


if __name__ == "__main__":
    main()
