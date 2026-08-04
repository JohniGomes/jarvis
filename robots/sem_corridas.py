"""Robo diario: coleta quem esta aprovado sem nenhuma corrida (Praca de Sao
Paulo) no sistema.entregoaguasclaras.com.br e sobrescreve a tabela
sem_corridas no Supabase.

Uso local: python -m robots.sem_corridas (com SISTEMA_EMAIL, SISTEMA_PASSWORD,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY no ambiente / .env).
"""
import os
import re
import sys
from datetime import date, timedelta

import requests
from playwright.sync_api import sync_playwright

BASE_URL = "https://sistema.entregoaguasclaras.com.br"
JANELA_DIAS = 15
PRACA = "SAO PAULO"


def log(msg):
    print(msg, flush=True)


def login(page):
    page.goto(f"{BASE_URL}/approved-follow-up")
    page.get_by_label("E-mail").fill(os.environ["SISTEMA_EMAIL"])
    senha = page.get_by_label("Password")
    if senha.count() == 0:
        senha = page.get_by_label("Senha")
    senha.fill(os.environ["SISTEMA_PASSWORD"])
    page.get_by_role("button", name=re.compile("Entrar", re.I)).click()
    page.wait_for_load_state("networkidle", timeout=30000)
    if "login" in page.url.lower():
        raise RuntimeError("Ainda na tela de login depois de tentar entrar -- confira SISTEMA_EMAIL/SISTEMA_PASSWORD.")


def aplicar_filtros(page):
    page.goto(f"{BASE_URL}/approved-follow-up")
    page.wait_for_load_state("networkidle", timeout=30000)

    # Praca -- o dropdown mostra "São Paulo" acentuado, mas a tabela depois
    # exibe "SAO PAULO" sem acento; casa só por "Paulo" pra não depender de
    # acentuação.
    page.get_by_label("Praça").click()
    page.get_by_role("option", name=re.compile("Paulo", re.I)).click()

    # <input type="date"> espera valor ISO (yyyy-mm-dd) no fill(), mesmo que
    # a tela mostre no formato dd/mm/yyyy.
    hoje = date.today()
    inicio = hoje - timedelta(days=JANELA_DIAS)
    page.get_by_label("Data Inicial Aprovação").fill(inicio.strftime("%Y-%m-%d"))
    page.get_by_label("Data Final Aprovação").fill(hoje.strftime("%Y-%m-%d"))
    page.get_by_role("button", name=re.compile("BUSCAR", re.I)).click()
    page.wait_for_load_state("networkidle", timeout=30000)

    # "Registros por pagina" -> Todos (é um QSelect do Quasar; o clique tem
    # que ser no combobox dentro do rodapé da tabela, não no texto do label).
    page.locator(".q-table__bottom .q-select").click()
    page.get_by_role("option", name=re.compile("Todos", re.I)).click()
    page.wait_for_timeout(1500)


def extrair_linhas(page):
    linhas = []
    trs = page.locator("table tbody tr")
    count = trs.count()
    for i in range(count):
        tds = trs.nth(i).locator("td")
        if tds.count() < 8:
            continue
        nome = tds.nth(1).inner_text().strip()
        contato = tds.nth(2).inner_text().strip()
        cpf = tds.nth(3).inner_text().strip()
        praca = tds.nth(4).inner_text().strip()
        corridas_txt = tds.nth(5).inner_text().strip()
        aprovado_em = tds.nth(7).inner_text().strip()
        if not nome or not cpf:
            continue
        try:
            corridas = int(re.sub(r"\D", "", corridas_txt) or "0")
        except ValueError:
            corridas = 0
        if corridas != 0:
            continue  # só "sem corridas" mesmo com o filtro de data já aplicado
        telefone = re.sub(r"\D", "", contato)
        if len(telefone) in (10, 11):
            telefone = "55" + telefone
        cpf_digits = re.sub(r"\D", "", cpf).zfill(11)
        linhas.append({
            "cpf": cpf_digits,
            "nome": nome,
            "telefone": telefone or None,
            "praca": praca or None,
            "aprovado_em": _to_iso(aprovado_em),
            "corridas": corridas,
        })
    return linhas


def _to_iso(data_br):
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", data_br or "")
    if not m:
        return None
    d, mo, y = m.groups()
    return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"


def upsert_supabase(linhas):
    # Visão "não congelada": a tabela é substituída por completo a cada
    # coleta (delete-all + insert), não só um merge por CPF -- senão quem
    # sai da lista (voltou a ter corrida, ou saiu da janela de dias) ficaria
    # com um registro velho pra sempre.
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    del_resp = requests.delete(
        f"{url}/rest/v1/sem_corridas?cpf=not.is.null",
        headers={**headers, "Prefer": "return=minimal"},
        timeout=30,
    )
    if not del_resp.ok:
        raise RuntimeError(f"Falha ao limpar sem_corridas: {del_resp.status_code} {del_resp.text}")

    if not linhas:
        log("Nenhuma linha coletada -- tabela ficou vazia.")
        return
    resp = requests.post(
        f"{url}/rest/v1/sem_corridas",
        headers={**headers, "Prefer": "return=minimal"},
        json=linhas,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Falha ao inserir em sem_corridas: {resp.status_code} {resp.text}")
    log(f"sem_corridas: tabela substituída, {len(linhas)} linhas atuais.")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            log("Login em sistema.entregoaguasclaras.com.br...")
            login(page)
            log("Aplicando filtros (Praça=SAO PAULO, janela de dias, Todos)...")
            aplicar_filtros(page)
            log("Extraindo linhas da tabela...")
            linhas = extrair_linhas(page)
            log(f"{len(linhas)} entregadores sem corridas encontrados.")
            upsert_supabase(linhas)
        except Exception:
            page.screenshot(path="robots/debug_sem_corridas.png", full_page=True)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
