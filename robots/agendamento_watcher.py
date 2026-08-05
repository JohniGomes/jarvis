"""Vigia local: fica rodando continuamente (não é um robô de 1x/dia como os
outros) escutando a tabela agendamento_status por pedidos pendentes
(criados pelo botão Liberar/Bloquear Agendamento do painel, via a Edge
Function agendamento-toggle) e processa na hora -- login uma vez só,
depois só checa a cada poucos segundos (POLL_SECONDS) se tem pedido novo.

Precisa rodar na SUA máquina (não GitHub Actions): franqueado.entregolog.com
tem um WAF (Akamai) que bloqueia IP de nuvem/datacenter, igual o robô do D-1.

Como o upload de elegibilidade SUBSTITUI a lista inteira no site deles, a
gente nunca manda só "quem mudou" -- sempre reconstrói o CSV inteiro a
partir da tabela agendamento_elegibilidade (espelho completo), só
atualizando ali as 12 linhas (1 REGION + 11 SUB_REGION de São Paulo) da
pessoa que acabou de ser liberada/bloqueada. Assim quem não foi tocado
nunca perde a configuração que já tinha.

Uso: python -m robots.agendamento_watcher (roda pra sempre, Ctrl+C pra
parar). Precisa de SISTEMA... não, precisa de FRANQUEADO_EMAIL,
FRANQUEADO_PASSWORD, EMAIL_IMAP_PASSWORD, SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY no ambiente/.env.
"""
import csv
import io
import os
import re
import sys
import time
import traceback
from datetime import datetime

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.franqueado_login import login as franqueado_login

load_dotenv()

POLL_SECONDS = 2
RETRY_SLEEP_SECONDS = 30
RELOGIN_EVERY_SECONDS = 6 * 60 * 60  # sessão pode expirar em runs muito longos -- refaz login preventivamente a cada 6h

# São Paulo: 1 região + 11 subpraças, extraídas da planilha "Elegibilidade
# Jarvis" em uso até 05/08/2026. Se o franqueado criar/renomear subpraças,
# ajuste aqui (e rode robots/agendamento_seed.py de novo pra reimportar).
SP_REGION_ID = "3841c245-fac1-40a6-8b8f-8d6876447a6d"
SP_SUB_REGION_IDS = [
    "339fa45e-5cd7-412d-ac72-2fa52ba21763",
    "6934118f-3fb0-4acd-962b-e9bb68c3699c",
    "695dfbe5-bd3a-4e2b-a654-8b8af0eeba8b",
    "87791f8f-9c75-4119-b5fa-9b6bd949fb6a",
    "8b533a90-adab-4cc3-a755-362246867ba5",
    "b5abb6d4-8ca8-4556-b143-6be36eb8c1f6",
    "c838bd2d-5be4-401a-8ad2-b9d6a9d87a58",
    "d10726bd-79b3-42bd-a836-2bf65db276fb",
    "fa9edb08-29d7-494b-80ba-8c2af20f2ceb",
    "fe841dac-692b-4855-aa0b-383a17054038",
    "ff380776-9d85-403d-9214-068c6eba6d09",
]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _supa_headers():
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    return url, {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def buscar_pendentes(url, headers):
    r = requests.get(
        f"{url}/rest/v1/agendamento_status?pendente=not.is.null&select=cpf,ifood_id,nome,pendente",
        headers=headers, timeout=15,
    )
    r.raise_for_status()
    return r.json()


def aplicar_pendentes_na_elegibilidade(url, headers, pendentes):
    # Reescreve as 12 linhas (REGION + 11 SUB_REGION) de cada pessoa
    # pendente, com enabled = (pendente == 'liberar'). Upsert por
    # (ifood_id, reference_id, tipo) -- cria se não existia ainda.
    linhas = []
    for p in pendentes:
        enabled = p["pendente"] == "liberar"
        linhas.append({"ifood_id": p["ifood_id"], "reference_id": SP_REGION_ID, "tipo": "REGION", "enabled": enabled})
        for sub_id in SP_SUB_REGION_IDS:
            linhas.append({"ifood_id": p["ifood_id"], "reference_id": sub_id, "tipo": "SUB_REGION", "enabled": enabled})
    resp = requests.post(
        f"{url}/rest/v1/agendamento_elegibilidade?on_conflict=ifood_id,reference_id,tipo",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=linhas, timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Falha ao atualizar agendamento_elegibilidade: {resp.status_code} {resp.text}")


def montar_csv_completo(url, headers):
    todas = []
    offset, page = 0, 1000
    while True:
        r = requests.get(
            f"{url}/rest/v1/agendamento_elegibilidade?select=ifood_id,reference_id,tipo,enabled",
            headers={**headers, "Range": f"{offset}-{offset + page - 1}"},
            timeout=30,
        )
        r.raise_for_status()
        rows = r.json()
        todas += rows
        if len(rows) < page:
            break
        offset += page

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["DRIVER_ID", "REFERENCE_ID", "TYPE", "ENABLED"])
    for r in todas:
        w.writerow([r["ifood_id"], r["reference_id"], r["tipo"], "TRUE" if r["enabled"] else "FALSE"])
    return buf.getvalue(), len(todas)


def enviar_csv_elegibilidade(page, csv_texto):
    caminho = "robots/agendamento_upload_tmp.csv"
    with open(caminho, "w", encoding="utf-8", newline="") as f:
        f.write(csv_texto)

    page.goto("https://franqueado.entregolog.com/supply/driver-booking-import")
    page.wait_for_load_state("networkidle", timeout=30000)
    page.wait_for_timeout(800)
    page.get_by_role("radiogroup").get_by_text("Elegibilidade", exact=True).click()
    page.wait_for_timeout(800)

    file_input = page.locator("input[type=file]")
    file_input.set_input_files(caminho)
    page.wait_for_timeout(800)

    botao_enviar = page.get_by_role("button", name=re.compile("^Enviar$", re.I))
    botao_enviar.wait_for(timeout=10000)
    botao_enviar.click()
    page.wait_for_timeout(3000)
    page.wait_for_load_state("networkidle", timeout=30000)

    os.remove(caminho)


def marcar_concluido(url, headers, pendentes):
    for p in pendentes:
        novo_status = "liberado" if p["pendente"] == "liberar" else "bloqueado"
        requests.patch(
            f"{url}/rest/v1/agendamento_status?cpf=eq.{p['cpf']}",
            headers={**headers, "Prefer": "return=minimal"},
            json={"status": novo_status, "pendente": None, "erro_msg": None},
            timeout=15,
        )


def marcar_erro(url, headers, pendentes, msg):
    for p in pendentes:
        requests.patch(
            f"{url}/rest/v1/agendamento_status?cpf=eq.{p['cpf']}",
            headers={**headers, "Prefer": "return=minimal"},
            json={"erro_msg": msg[:500]},
            timeout=15,
        )


def main():
    url, headers = _supa_headers()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)

        log("Login em franqueado.entregolog.com...")
        franqueado_login(page)
        log("Login OK. Vigiando agendamento_status a cada %ds..." % POLL_SECONDS)
        login_em = time.time()

        while True:
            try:
                if time.time() - login_em > RELOGIN_EVERY_SECONDS:
                    log("Refazendo login preventivo (sessão longa)...")
                    franqueado_login(page)
                    login_em = time.time()

                pendentes = buscar_pendentes(url, headers)
                if not pendentes:
                    time.sleep(POLL_SECONDS)
                    continue

                nomes = ", ".join(f"{p['nome']} ({p['pendente']})" for p in pendentes)
                log(f"{len(pendentes)} pedido(s) pendente(s): {nomes}")

                aplicar_pendentes_na_elegibilidade(url, headers, pendentes)
                csv_texto, total_linhas = montar_csv_completo(url, headers)
                log(f"Enviando planilha de elegibilidade ({total_linhas} linhas)...")
                enviar_csv_elegibilidade(page, csv_texto)
                marcar_concluido(url, headers, pendentes)
                log("Concluído.")
            except Exception as e:
                erro_msg = f"{type(e).__name__}: {e}"
                log(f"ERRO ao processar pendentes: {erro_msg}")
                traceback.print_exc()
                try:
                    page.screenshot(path="robots/debug_agendamento_watcher.png", full_page=True)
                except Exception:
                    pass
                try:
                    marcar_erro(url, headers, pendentes, erro_msg)
                except Exception:
                    pass
                # Tenta relogar (pode ter sido sessão expirada) antes do próximo ciclo.
                try:
                    franqueado_login(page)
                    login_em = time.time()
                except Exception:
                    pass
                time.sleep(RETRY_SLEEP_SECONDS)


if __name__ == "__main__":
    main()
