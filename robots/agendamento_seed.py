"""Backfill único: importa o estado ATUAL da planilha "Elegibilidade Jarvis"
(fonte da verdade manual até hoje) pra dentro do Supabase, antes de o botão
Liberar/Bloquear Agendamento do painel assumir o controle.

Roda uma vez só. Depois disso, agendamento_elegibilidade é sempre atualizada
pelo robots/agendamento_watcher.py (nunca mais direto pela planilha).

Uso: python -m robots.agendamento_seed (com SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY no ambiente/.env).
"""
import csv
import io
import os

import requests
from dotenv import load_dotenv

load_dotenv()

SHEET_ID = "1DJoKoGGdeSceaQio64fdXNCoahoyJCQ_4zVG42L1XNA"
SHEET_GID = "1758304617"
SHEET_CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={SHEET_GID}"


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


def baixar_planilha():
    resp = requests.get(SHEET_CSV_URL, timeout=30)
    resp.raise_for_status()
    linhas = list(csv.DictReader(io.StringIO(resp.text)))
    log(f"{len(linhas)} linhas na planilha (DRIVER_ID/REFERENCE_ID/TYPE/ENABLED).")
    return linhas


def fetch_all(url, headers, table, select):
    out = []
    offset, page = 0, 1000
    while True:
        r = requests.get(
            f"{url}/rest/v1/{table}?select={select}",
            headers={**headers, "Range": f"{offset}-{offset + page - 1}"},
            timeout=30,
        )
        r.raise_for_status()
        rows = r.json()
        out += rows
        if len(rows) < page:
            break
        offset += page
    return out


def main():
    url, headers = _supa_headers()
    linhas_planilha = baixar_planilha()

    entregadores = fetch_all(url, headers, "entregadores", "cpf,nome,ifood_id")
    por_ifood_id = {e["ifood_id"]: e for e in entregadores if e.get("ifood_id")}
    log(f"{len(por_ifood_id)} entregadores com ifood_id cadastrado.")

    # 1) Espelha a planilha inteira em agendamento_elegibilidade.
    elegibilidade_rows = []
    for r in linhas_planilha:
        elegibilidade_rows.append({
            "ifood_id": r["DRIVER_ID"],
            "reference_id": r["REFERENCE_ID"],
            "tipo": r["TYPE"],
            "enabled": r["ENABLED"].strip().upper() == "TRUE",
        })
    chunk = 500
    for i in range(0, len(elegibilidade_rows), chunk):
        batch = elegibilidade_rows[i:i + chunk]
        resp = requests.post(
            f"{url}/rest/v1/agendamento_elegibilidade?on_conflict=ifood_id,reference_id,tipo",
            headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=batch, timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(f"Falha ao upsert agendamento_elegibilidade (lote {i}): {resp.status_code} {resp.text}")
    log(f"agendamento_elegibilidade: {len(elegibilidade_rows)} linhas espelhadas.")

    # 2) Deriva o status (liberado/bloqueado) por CPF, só pra quem a gente
    # consegue identificar via ifood_id -> entregadores.
    por_driver = {}
    for r in linhas_planilha:
        por_driver.setdefault(r["DRIVER_ID"], []).append(r["ENABLED"].strip().upper() == "TRUE")

    status_rows = []
    sem_match = 0
    for ifood_id, enabled_flags in por_driver.items():
        entregador = por_ifood_id.get(ifood_id)
        if not entregador:
            sem_match += 1
            continue
        status_rows.append({
            "cpf": entregador["cpf"],
            "ifood_id": ifood_id,
            "nome": entregador["nome"],
            "status": "liberado" if any(enabled_flags) else "bloqueado",
        })
    log(f"{len(status_rows)} status derivados, {sem_match} ifood_id da planilha sem entregador correspondente (ok, provavelmente de outra praça).")

    for i in range(0, len(status_rows), chunk):
        batch = status_rows[i:i + chunk]
        resp = requests.post(
            f"{url}/rest/v1/agendamento_status?on_conflict=cpf",
            headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=batch, timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(f"Falha ao upsert agendamento_status (lote {i}): {resp.status_code} {resp.text}")
    log(f"agendamento_status: {len(status_rows)} linhas gravadas.")


if __name__ == "__main__":
    main()
