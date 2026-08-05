"""Login automatizado no franqueado.entregolog.com, incluindo o código de
verificação enviado por e-mail (lido via IMAP, sem intervenção humana).
"""
import os
import re
import time

from playwright.sync_api import Page

from robots.email_otp import buscar_codigo_acesso

BASE_URL = "https://franqueado.entregolog.com"


def _clicar_continuar(page: Page):
    for label in ("Continuar", "Entrar", "Avançar", "Confirmar", "Enviar"):
        botao = page.get_by_role("button", name=re.compile(label, re.I))
        if botao.count() > 0:
            botao.first.click()
            return
    page.keyboard.press("Enter")


def login(page: Page):
    email = os.environ["FRANQUEADO_EMAIL"]
    senha = os.environ["FRANQUEADO_PASSWORD"]

    # "networkidle" nunca chega através do proxy residencial -- scripts de
    # analytics/PerimeterX ficam mandando requisição em loop de fundo, e a
    # latência extra do proxy nunca deixa a rede "quieta" a tempo. Espera só
    # o campo de e-mail aparecer, que é o que realmente importa aqui.
    page.goto(BASE_URL)

    # E-mail e senha aparecem juntos no mesmo formulário (diferente do fluxo
    # em duas telas que a automação de Gestor de Escalas assume pra outra
    # URL) -- preenche os dois e clica em Continuar uma única vez.
    # Duas telas separadas: e-mail primeiro (com "Continuar"), senha depois.
    campo_email = page.get_by_label("E-mail")
    if campo_email.count() == 0:
        campo_email = page.get_by_placeholder(re.compile("e-mail", re.I))
    campo_email.first.wait_for(timeout=30000)
    campo_email.first.fill(email)
    _clicar_continuar(page)

    campo_senha = page.get_by_label(re.compile("senha", re.I))
    if campo_senha.count() == 0:
        campo_senha = page.get_by_placeholder(re.compile("senha", re.I))
    campo_senha.first.wait_for(timeout=15000)
    campo_senha.first.fill(senha)
    _clicar_continuar(page)

    # Um modal "Código enviado" aparece por cima do formulário e precisa ser
    # fechado antes do campo de código ficar clicável -- com o proxy
    # residencial (latência maior), o modal pode demorar bem mais que os
    # 1500ms fixos de antes pra aparecer, então espera de verdade por ele
    # em vez de só checar depois de um tempo fixo.
    botao_ok = page.get_by_role("button", name=re.compile("OK, entendi", re.I))
    try:
        botao_ok.first.wait_for(timeout=10000)
        botao_ok.first.click()
    except Exception:
        pass  # modal pode não aparecer sempre -- segue sem ele

    # Um código de 6 dígitos é enviado por e-mail (naoresponda@entregolog.com,
    # assunto "Código de acesso") -- lê a caixa via IMAP e completa sozinho.
    page.wait_for_timeout(3000)  # dá tempo do e-mail chegar antes de pollar
    codigo = buscar_codigo_acesso(email, os.environ["EMAIL_IMAP_PASSWORD"])
    campo_codigo = page.get_by_label(re.compile("c.digo", re.I))
    if campo_codigo.count() == 0:
        campo_codigo = page.get_by_placeholder(re.compile("c.digo", re.I))
    campo_codigo.first.wait_for(timeout=30000)
    campo_codigo.first.fill(codigo)
    _clicar_continuar(page)
    page.wait_for_timeout(3000)

    # Mesmo motivo do goto() acima -- não depende de networkidle, só do
    # resultado final (URL mudou pra fora do login = deu certo).
    try:
        page.wait_for_url(lambda url: "login" not in url.lower(), timeout=20000)
    except Exception:
        pass
    if "login" in page.url.lower():
        raise RuntimeError("Ainda na tela de login depois do código -- confira credenciais/código.")


if __name__ == "__main__":
    from dotenv import load_dotenv
    from playwright.sync_api import sync_playwright

    from robots.browser_launch import launch_browser

    load_dotenv()

    with sync_playwright() as p:
        browser = launch_browser(p.chromium)
        page = browser.new_page()
        try:
            login(page)
            print("Login OK. URL atual:", page.url)
            page.screenshot(path="robots/debug_franqueado_login.png", full_page=True)
        except Exception:
            page.screenshot(path="robots/debug_franqueado_login.png", full_page=True)
            raise
        finally:
            browser.close()
