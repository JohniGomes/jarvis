"""Robo diario: sincroniza o roster de entregadores aprovados (Praca de Sao
Paulo) a partir da lista de Registros (sistema.entregoaguasclaras.com.br) pra
tabela entregadores no Supabase -- é o que alimenta a data_aprovacao usada
pelas campanhas (Start EntreGô etc), sem precisar cadastrar manualmente.

A tela /registrations tem um botao "EXPORTAR CSV" por status (Pendente, Erro
no CNPJ, Aguardando Aprovacao, Aprovado, Rejeitado) -- o export ignora os
filtros de praca/data aplicados na tela e sempre traz TODOS os registros
daquele status, entao filtramos praca=SAO PAULO em Python depois de baixar.

Uso local: python -m robots.entregadores_sync (com SISTEMA_EMAIL,
SISTEMA_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY no ambiente/.env).
"""
import csv
import io
import os
import re

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

BASE_URL = "https://sistema.entregoaguasclaras.com.br"
PRACA = "SAO PAULO"


def log(msg):
    print(msg, flush=True)


def login(page):
    page.goto(f"{BASE_URL}/registrations")
    page.get_by_label("E-mail").fill(os.environ["SISTEMA_EMAIL"])
    senha = page.get_by_label("Password")
    if senha.count() == 0:
        senha = page.get_by_label("Senha")
    senha.fill(os.environ["SISTEMA_PASSWORD"])
    page.get_by_role("button", name=re.compile("Entrar", re.I)).click()
    page.wait_for_load_state("networkidle", timeout=30000)
    if "login" in page.url.lower():
        raise RuntimeError("Ainda na tela de login depois de tentar entrar -- confira SISTEMA_EMAIL/SISTEMA_PASSWORD.")


def baixar_csv_aprovados(page):
    page.goto(f"{BASE_URL}/registrations")
    page.wait_for_load_state("networkidle", timeout=30000)
    # Ordem das secoes na tela: Pendente, Erro no CNPJ, Aguardando Aprovacao,
    # Aprovado, Rejeitado -- a 4a (indice 3) e a que interessa.
    export_buttons = page.get_by_role("button", name=re.compile("EXPORTAR CSV", re.I))
    with page.expect_download(timeout=30000) as dl_info:
        export_buttons.nth(3).click()
    download = dl_info.value
    caminho_temp = download.path()
    with open(caminho_temp, "r", encoding="utf-8") as f:
        return f.read()


def _telefone(raw):
    digitos = re.sub(r"\D", "", raw or "")
    if len(digitos) in (10, 11):
        return "55" + digitos
    return digitos or None


def _data_iso(raw):
    # Vem como "2026-08-05T00:00:00.000Z" -- só a data importa.
    m = re.match(r"(\d{4}-\d{2}-\d{2})", raw or "")
    return m.group(1) if m else None


def parse_csv(texto_csv):
    linhas = []
    for row in csv.DictReader(io.StringIO(texto_csv)):
        if (row.get("praca") or "").strip().upper() != PRACA:
            continue
        cpf_digits = re.sub(r"\D", "", row.get("cpf") or "").zfill(11)
        nome = (row.get("name") or "").strip()
        if not cpf_digits or not nome:
            continue
        linhas.append({
            "cpf": cpf_digits,
            "nome": nome,
            "telefone": _telefone(row.get("phone")),
            "data_aprovacao": _data_iso(row.get("approval_date")),
            "ifood_id": (row.get("ifood_id") or "").strip() or None,
        })
    return linhas


def _dedupe(linhas):
    por_cpf = {}
    for r in linhas:
        por_cpf[r["cpf"]] = r
    return list(por_cpf.values())


def upsert_supabase(linhas):
    linhas = _dedupe(linhas)
    if not linhas:
        log("Nenhum aprovado em SAO PAULO no export -- nada pra enviar.")
        return
    # .strip() -- segredos colados em GitHub Actions Secrets às vezes
    # carregam uma quebra de linha/espaço a mais, o que vira um
    # InvalidHeader na hora de montar o Authorization.
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    # entregadores e o roster completo (não sobrescrito todo dia como o Sem
    # Corridas) -- upsert por CPF, pra não perder quem já estava cadastrado.
    chunk_size = 500
    for i in range(0, len(linhas), chunk_size):
        chunk = linhas[i:i + chunk_size]
        resp = requests.post(
            f"{url}/rest/v1/entregadores?on_conflict=cpf",
            headers=headers, json=chunk, timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(f"Falha ao upsert em entregadores (lote {i}-{i + len(chunk)}): {resp.status_code} {resp.text}")
    log(f"entregadores: {len(linhas)} linhas enviadas (upsert por CPF).")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        try:
            log("Login em sistema.entregoaguasclaras.com.br...")
            login(page)
            log("Exportando CSV de Aprovados...")
            texto_csv = baixar_csv_aprovados(page)
        except Exception:
            page.screenshot(path="robots/debug_entregadores_sync.png", full_page=True)
            raise
        finally:
            browser.close()

    log("Filtrando praça SAO PAULO...")
    linhas = parse_csv(texto_csv)
    log(f"{len(linhas)} entregadores aprovados em SAO PAULO.")
    upsert_supabase(linhas)


if __name__ == "__main__":
    main()
