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

MAX_TENTATIVAS_LOGIN = 4


def _login_com_retry(p):
    """Tenta logar, RECRIANDO o browser (nova conexão TCP com o proxy) a
    cada tentativa -- reusar a mesma conexão travada nas tentativas
    seguintes não ajuda em nada se o problema for aquela conexão/IP
    específico estar ruim. Retorna (browser, page) já logados."""
    ultimo_erro = None
    for tentativa in range(1, MAX_TENTATIVAS_LOGIN + 1):
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        try:
            franqueado_login(page)
            return browser, page
        except Exception as e:
            ultimo_erro = e
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS_LOGIN} de login falhou: {type(e).__name__}: {e}")
            try:
                page.screenshot(path=f"robots/debug_agendamento_watcher_tentativa{tentativa}.png", full_page=True)
            except Exception:
                pass
            browser.close()
            if tentativa < MAX_TENTATIVAS_LOGIN:
                time.sleep(8)
    raise ultimo_erro


def main():
    url, headers = _supa_headers()

    with sync_playwright() as p:
        log("Login em franqueado.entregolog.com...")
        browser, page = _login_com_retry(p)
        try:
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
