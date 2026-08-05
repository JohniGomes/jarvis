"""Lança o browser Playwright, opcionalmente atrás de um proxy residencial.

franqueado.entregolog.com tem um WAF (Akamai) que bloqueia IP de
nuvem/datacenter -- por isso d1_sync e agendamento_watcher hoje só rodam na
máquina local. Configurando PROXY_SERVER (+ PROXY_USERNAME/PROXY_PASSWORD se
o provedor pedir autenticação) no .env/Secrets, o Playwright passa a sair
por um IP residencial e esses robôs podem voltar a rodar no GitHub Actions.

Sem PROXY_SERVER configurado, comporta-se exatamente como antes (sem proxy).
"""
import os

from playwright.sync_api import BrowserType


def launch_browser(chromium: BrowserType, headless: bool = True):
    proxy_server = os.environ.get("PROXY_SERVER", "").strip()
    if not proxy_server:
        return chromium.launch(headless=headless)

    proxy = {"server": proxy_server}
    usuario = os.environ.get("PROXY_USERNAME", "").strip()
    senha = os.environ.get("PROXY_PASSWORD", "").strip()
    if usuario:
        proxy["username"] = usuario
    if senha:
        proxy["password"] = senha

    return chromium.launch(headless=headless, proxy=proxy)
