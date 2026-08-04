"""Gera e baixa o relatorio de Performance (D-1) do franqueado.entregolog.com.
Script isolado so pra descobrir o formato do arquivo baixado -- ainda nao
faz upsert no Supabase.
"""
import re
from datetime import date, timedelta

from playwright.sync_api import sync_playwright

from robots.franqueado_login import login, BASE_URL


def _selecionar_dia_calendario(page, label, data_alvo):
    page.get_by_label(label).first.click()
    page.wait_for_timeout(300)
    dia = str(data_alvo.day)
    # O calendário mostra um número por célula -- pega o elemento cujo texto
    # é exatamente esse número (evita casar com "12" dentro de "2026" etc).
    page.get_by_text(re.compile(rf"^{dia}$")).first.click()
    page.wait_for_timeout(300)


def gerar_e_baixar(page, data_inicio, data_fim, destino):
    # Não existe URL direta conhecida -- navega pelo menu lateral, igual um
    # usuário faria. O menu começa recolhido (só ícones); "Expandir" revela
    # os textos dos itens.
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle", timeout=30000)
    expandir = page.get_by_role("button", name="Expandir")
    if expandir.count() > 0:
        expandir.click()
        page.wait_for_timeout(1000)
    # "Operador logístico" é um grupo recolhível -- precisa abrir antes dos
    # itens (Relatórios etc.) aparecerem clicáveis.
    page.get_by_text("Operador logístico", exact=False).first.click()
    page.wait_for_timeout(500)
    page.get_by_text("Relatórios", exact=False).first.click()
    page.wait_for_load_state("networkidle", timeout=30000)

    # É um combobox customizado (downshift) -- o <input> real fica coberto
    # por uma div estilizada, então clica no texto visível "Selecione".
    page.get_by_text("Selecione", exact=True).first.click()
    page.get_by_role("option", name=re.compile("Performance", re.I)).click()

    # É um datepicker próprio (não <input type="date">) -- clica no campo
    # pra abrir o calendário, depois clica no número do dia certo. Como
    # início e fim caem no mesmo mês nos casos de uso do robô (relatório de
    # D-1, sempre 1 dia), não precisa navegar entre meses aqui.
    _selecionar_dia_calendario(page, "Data início", data_inicio)
    _selecionar_dia_calendario(page, "Data fim", data_fim)

    with page.expect_download(timeout=60000) as download_info:
        page.get_by_role("button", name=re.compile("Gerar Relat.rio", re.I)).click()
    download = download_info.value
    download.save_as(destino)
    print("Arquivo salvo em:", destino)
    print("Nome sugerido:", download.suggested_filename)


if __name__ == "__main__":
    hoje = date.today()
    ontem = hoje - timedelta(days=1)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        try:
            print("Login...")
            login(page)
            print(f"Gerando relatório Performance {ontem} - {ontem}...")
            gerar_e_baixar(page, ontem, ontem, "robots/debug_relatorio_download")
        except Exception:
            page.screenshot(path="robots/debug_relatorio.png", full_page=True)
            raise
        finally:
            browser.close()
