"""Processa pendentes de agendamento_status UMA VEZ e sai -- versão do
agendamento_watcher.py feita pra rodar no GitHub Actions, disparada por um
Database Webhook do Supabase (evento repository_dispatch) sempre que alguém
clica Liberar/Bloquear Agendamento no painel, em vez de ficar num loop
local escutando a cada 2s pra sempre.

Uso: python -m robots.agendamento_processar
"""
import os
import sys

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.agendamento_watcher import _supa_headers, log, processar_ciclo
from robots.browser_launch import launch_browser
from robots.franqueado_login import login as franqueado_login

load_dotenv()


def main():
    url, headers = _supa_headers()

    with sync_playwright() as p:
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        try:
            log("Login em franqueado.entregolog.com...")
            franqueado_login(page)
            teve_pendente = processar_ciclo(page, url, headers)
            if not teve_pendente:
                log("Nenhum pendente encontrado (webhook disparou à toa ou já foi processado).")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
