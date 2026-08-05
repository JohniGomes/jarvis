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

MAX_TENTATIVAS_LOGIN = 3


def _login_com_retry(page):
    # A conexão via proxy residencial, saindo da rede do GitHub Actions, às
    # vezes trava/cai no meio do fluxo (goto, formulário ou código) --
    # instabilidade de rede, não um bug de timing. Tenta de novo em vez de
    # falhar direto na primeira instabilidade.
    for tentativa in range(1, MAX_TENTATIVAS_LOGIN + 1):
        try:
            franqueado_login(page)
            return
        except Exception as e:
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS_LOGIN} de login falhou: {type(e).__name__}: {e}")
            if tentativa == MAX_TENTATIVAS_LOGIN:
                raise
            time.sleep(5)


def main():
    url, headers = _supa_headers()

    with sync_playwright() as p:
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        try:
            log("Login em franqueado.entregolog.com...")
            _login_com_retry(page)
            teve_pendente = processar_ciclo(page, url, headers)
            if not teve_pendente:
                log("Nenhum pendente encontrado (webhook disparou à toa ou já foi processado).")
        except Exception:
            try:
                page.screenshot(path="robots/debug_agendamento_watcher.png", full_page=True)
            except Exception:
                pass
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
