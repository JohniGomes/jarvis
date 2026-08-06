"""Processa pendentes de agendamento_status UMA VEZ e sai -- versão do
agendamento_watcher.py feita pra rodar no GitHub Actions, disparada por um
Database Webhook do Supabase (evento repository_dispatch) sempre que alguém
clica Liberar/Bloquear Agendamento no painel, em vez de ficar num loop
local escutando a cada 2s pra sempre.

Uso: python -m robots.agendamento_processar
"""
import os
import sys
import time

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.agendamento_watcher import _supa_headers, log, processar_ciclo
from robots.browser_launch import launch_browser
from robots.franqueado_login import login as franqueado_login

load_dotenv()

MAX_TENTATIVAS = 4


def main():
    url, headers = _supa_headers()

    # Via proxy residencial saindo do GitHub Actions, a conexão pode travar
    # em QUALQUER page.goto -- não só no login, também no upload da
    # planilha dentro de processar_ciclo. Por isso o retry envolve o fluxo
    # inteiro (login + processar), sempre recriando o browser do zero a
    # cada tentativa.
    ultimo_erro = None
    with sync_playwright() as p:
        for tentativa in range(1, MAX_TENTATIVAS + 1):
            browser = launch_browser(p.chromium)
            page = browser.new_page(accept_downloads=True)
            try:
                log("Login em franqueado.entregolog.com...")
                franqueado_login(page)
                teve_pendente = processar_ciclo(page, url, headers)
                if not teve_pendente:
                    log("Nenhum pendente encontrado (webhook disparou à toa ou já foi processado).")
                browser.close()
                return
            except Exception as e:
                ultimo_erro = e
                log(f"Tentativa {tentativa}/{MAX_TENTATIVAS} falhou: {type(e).__name__}: {e}")
                try:
                    page.screenshot(path=f"robots/debug_agendamento_watcher_tentativa{tentativa}.png", full_page=True, timeout=5000)
                except Exception as screenshot_erro:
                    log(f"(não consegui tirar screenshot de erro: {screenshot_erro})")
                browser.close()
                if tentativa == MAX_TENTATIVAS:
                    raise ultimo_erro
                time.sleep(8)


if __name__ == "__main__":
    main()
