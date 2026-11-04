import io
import json

import pytest
from fastapi.testclient import TestClient  # noqa: E402

from app import scrape  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def c():
    client = TestClient(app)
    assert client.get("/api/jobs").status_code == 401
    assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"password": "secret"}).status_code == 200
    return client


def test_session(c):
    s = c.get("/api/session").json()
    assert s["logged_in"] and s["auth_required"] and not s["ai_enabled"]
    assert s["user"]["name"] == "Me"


def test_frontend_served():
    client = TestClient(app)
    assert "Job Hacker" in client.get("/").text
    assert "Job Hacker" in client.get("/job/3").text  # SPA fallback
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/manifest.webmanifest").json()["share_target"]


def test_job_crud_and_dupes(c):
    r = c.post("/api/jobs", json={"title": "Scrum Master", "company": "DBS",
                                   "url": "https://sg.linkedin.com/jobs/view/scrum-1234567?trk=x"})
    assert r.status_code == 201
    j = r.json()
    assert j["url"] == "https://www.linkedin.com/jobs/view/1234567/"
    assert j["status"] == "saved" and not j["has_description"]

    # Same link again fills the gap instead of duplicating
    r2 = c.post("/api/jobs", json={"title": "Scrum Master", "url": "https://www.linkedin.com/jobs/view/1234567",
                                    "description": "Lead teams"})
    assert r2.status_code == 200 and r2.json()["duplicate"] and r2.json()["description"] == "Lead teams"
    assert len(c.get("/api/jobs").json()) == 1

    # extract/url short-circuits on dupes without fetching
    e = c.post("/api/extract/url", json={"url": "linkedin.com/jobs/view/1234567"}).json()
    assert e["existing_id"] == j["id"]

    p = c.patch(f"/api/jobs/{j['id']}", json={"status": "applied", "notes": "called"}).json()
    assert p["status"] == "applied" and p["applied_at"] and p["notes"] == "called"
    assert c.patch(f"/api/jobs/{j['id']}", json={"status": "bogus"}).status_code == 400
    assert c.patch(f"/api/jobs/{j['id']}", json={"url": ""}).json()["url"] is None

    # job without link
    assert c.post("/api/jobs", json={"title": "No link job"}).status_code == 201
    assert c.post("/api/jobs", json={"title": "No link job 2", "url": ""}).status_code == 201

    assert c.delete(f"/api/jobs/{j['id']}").status_code == 200
    assert c.get(f"/api/jobs/{j['id']}").status_code == 404


def test_api_token_and_x_user():
    client = TestClient(app)
    r = client.post("/api/jobs", headers={"X-API-Key": "tok"}, json={"title": "From n8n", "url": "https://x.com/j/1"})
    assert r.status_code == 201
    assert client.post("/api/jobs", headers={"X-API-Key": "wrong"}, json={"title": "x"}).status_code == 401


def test_extract_url_failure_is_manual(c, monkeypatch):
    def boom(url, **kw):
        raise scrape.ScrapeError("That site blocks automatic reading.")
    monkeypatch.setattr("app.main.fetch_job", boom)
    r = c.post("/api/extract/url", json={"url": "https://blocked.example/job/9"})
    assert r.status_code == 422 and r.json()["needs_manual"]


def test_extract_url_success(c, monkeypatch):
    monkeypatch.setattr("app.main.fetch_job", lambda u, **kw: ({"title": "Agile Coach", "company": "Grab", "location": "",
                                                          "salary": "", "employment_type": "", "posted_date": "",
                                                          "description": "x" * 300}, "structured data"))
    r = c.post("/api/extract/url", json={"url": "https://careers.grab.com/job/5?utm_source=a"}).json()
    assert r["draft"]["title"] == "Agile Coach" and r["draft"]["url"] == "https://careers.grab.com/job/5"


def test_extract_text_without_ai(c):
    r = c.post("/api/extract/text", json={"text": "Delivery Lead\nGovTech\nWe need someone to lead delivery across teams."}).json()
    assert r["method"] == "basic" and r["draft"]["title"] == "Delivery Lead"
    assert c.post("/api/extract/text", json={"text": "short"}).status_code == 400


def test_ai_endpoints_report_clearly_when_off(c):
    j = c.post("/api/jobs", json={"title": "T", "description": "Some description"}).json()
    r = c.post(f"/api/jobs/{j['id']}/fit")
    assert r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["detail"]
    r = c.post(f"/api/jobs/{j['id']}/documents", json={"kind": "resume"})
    assert r.status_code == 400  # no resume yet


def test_ai_fit_and_docs_with_stub(c, monkeypatch):
    from app import ai
    monkeypatch.setattr(ai, "available", lambda e: e == "claude")
    monkeypatch.setattr(ai, "_ask", lambda system, user, max_tokens=0, **kw:
                        '{"score": 8, "verdict": "Good", "strengths": ["a"], "gaps": ["b"], "keywords": ["k"]}'
                        if "Score how well" in system else "TAILORED TEXT")
    c.post("/api/personas", json={"name": "Main", "resume_text": "My resume"})
    j = c.post("/api/jobs", json={"title": "AI job", "description": "Desc"}).json()
    f = c.post(f"/api/jobs/{j['id']}/fit").json()
    assert f["fit_score"] == 8 and f["fit"]["verdict"] == "Good"
    d = c.post(f"/api/jobs/{j['id']}/documents", json={"kind": "cover_letter"}).json()
    assert d["content"] == "TAILORED TEXT" and d["persona_name"] == "Main"
    assert c.patch(f"/api/documents/{d['id']}", json={"content": "edited"}).json()["content"] == "edited"
    r = c.get(f"/api/documents/{d['id']}/docx")
    assert r.status_code == 200 and r.content[:2] == b"PK"


def test_personas_default_logic(c):
    ps = c.get("/api/personas").json()
    assert sum(p["is_default"] for p in ps) == 1
    second = c.post("/api/personas", json={"name": "PO", "resume_text": "x"}).json()
    assert not second["is_default"]
    c.post(f"/api/personas/{second['id']}/default")
    assert [p["name"] for p in c.get("/api/personas").json() if p["is_default"]] == ["PO"]
    c.delete(f"/api/personas/{second['id']}")
    assert sum(p["is_default"] for p in c.get("/api/personas").json()) == 1


def test_csv_import(c):
    csv_text = ("Job URL,Job title,Company Name,Location,Published At,Status\n"
                "https://www.linkedin.com/jobs/view/1111111111,Scrum Master,Acme,Singapore,2026-04-01,Not started\n"
                "https://www.linkedin.com/jobs/view/2222222222,Agile Coach,Globex,Remote,2026-04-15,In progress\n"
                "https://www.linkedin.com/jobs/view/2222222222,Agile Coach,Globex,Remote,2026-04-15,In progress\n"
                ",,,,,\n")
    r = c.post("/api/import/csv", files={"file": ("jobs.csv", csv_text, "text/csv")}).json()
    assert r == {"rows": 4, "added": 2, "duplicates": 1, "skipped": 1}
    statuses = {j["title"]: j["status"] for j in c.get("/api/jobs").json()}
    assert statuses["Agile Coach"] == "applied" and statuses["Scrum Master"] == "saved"


def test_export_import_roundtrip(c):
    backup = c.get("/api/export").content
    data = json.loads(backup)
    assert data["format"] == "job-hacker" and data["profiles"][0]["jobs"]
    # importing the same backup again adds nothing new
    r = c.post("/api/import/backup", files={"file": ("b.json", io.BytesIO(backup), "application/json")}).json()
    assert r["jobs"] == 0 and r["duplicates"] > 0
    # a different profile name creates a profile
    data["profiles"][0]["name"] = "Wife"
    r = c.post("/api/import/backup", files={"file": ("b.json", json.dumps(data), "application/json")}).json()
    assert r["profiles"] == 1 and r["jobs"] > 0
    assert c.post("/api/import/backup", files={"file": ("x.json", "{}", "application/json")}).status_code == 400


def test_profiles(c):
    users = c.get("/api/session").json()["users"]
    wife = next(u for u in users if u["name"] == "Wife")
    me_jobs = len(c.get("/api/jobs").json())
    c.post(f"/api/users/{wife['id']}/select")
    assert c.get("/api/session").json()["user"]["name"] == "Wife"
    wife_jobs = c.get("/api/jobs").json()
    other = c.post("/api/users", json={"name": "Temp"}).json()
    assert c.get("/api/jobs").json() == []  # new profile is active and empty
    assert c.post("/api/users", json={"name": "temp"}).status_code == 409
    c.delete(f"/api/users/{other['id']}")
    c.post(f"/api/users/{wife['id']}/select")
    assert len(c.get("/api/jobs").json()) == len(wife_jobs)
    assert me_jobs > 0


def test_bulk_from_url_and_refresh(c, monkeypatch):
    def fake(url, **kw):
        if "blocked" in url:
            raise scrape.ScrapeError("That site blocks automatic reading.")
        return ({"title": "Bulk Coach", "company": "OCBC", "location": "Singapore", "salary": "S$10k",
                 "employment_type": "", "posted_date": "", "description": "Full description"}, "structured data")
    monkeypatch.setattr("app.main.fetch_job", fake)

    r = c.post("/api/jobs/from-url", json={"url": "https://careers.ocbc.com/job/1?utm_source=x"}).json()
    assert r["status"] == "added" and r["job"]["title"] == "Bulk Coach" and r["job"]["has_description"]
    assert c.post("/api/jobs/from-url", json={"url": "careers.ocbc.com/job/1"}).json()["status"] == "duplicate"
    f = c.post("/api/jobs/from-url", json={"url": "https://blocked.example/j"}).json()
    assert f["status"] == "failed" and "blocks" in f["reason"]
    assert c.post("/api/jobs/from-url", json={"url": ""}).json()["status"] == "failed"

    # refresh fills only empty fields
    j = c.post("/api/jobs", json={"title": "From CSV", "company": "Keep Me", "url": "https://x.example/csv/9"}).json()
    r = c.post(f"/api/jobs/{j['id']}/refresh").json()
    assert r["status"] == "updated" and set(r["filled"]) == {"location", "salary", "description"}
    full = c.get(f"/api/jobs/{j['id']}").json()
    assert full["company"] == "Keep Me" and full["description"] == "Full description"
    assert c.post(f"/api/jobs/{j['id']}/refresh").json()["status"] == "unchanged"
    nolink = c.post("/api/jobs", json={"title": "No link here"}).json()
    assert c.post(f"/api/jobs/{nolink['id']}/refresh").json()["status"] == "failed"



def test_engine_choice_local_vs_claude(c, monkeypatch):
    from app import ai
    calls = []
    monkeypatch.setattr(ai, "available", lambda e: True)
    monkeypatch.setattr(ai, "_ask_claude", lambda s, u, m: calls.append("claude") or "CLAUDE TEXT")
    monkeypatch.setattr(ai, "_ask_local", lambda s, u, m, j: calls.append("local") or "LOCAL TEXT")
    j = c.post("/api/jobs", json={"title": "Engine job", "description": "Desc"}).json()
    d1 = c.post(f"/api/jobs/{j['id']}/documents", json={"kind": "cover_letter", "engine": "local"}).json()
    d2 = c.post(f"/api/jobs/{j['id']}/documents", json={"kind": "cover_letter", "engine": "claude"}).json()
    assert calls == ["local", "claude"]
    assert d1["content"] == "LOCAL TEXT" and d1["engine"].startswith("Local")
    assert d2["engine"].startswith("Claude")
    assert c.post(f"/api/jobs/{j['id']}/documents", json={"kind": "resume", "engine": "bogus"}).status_code == 400


def test_engine_unavailable_is_clear(c, monkeypatch):
    from app import ai
    monkeypatch.setattr(ai, "available", lambda e: e == "claude")
    monkeypatch.setattr(ai, "local_status", lambda force=False: {"ok": False, "model": "qwen3:14b", "reason": "Couldn't reach Ollama."})
    j = c.post("/api/jobs", json={"title": "Engine job 2", "description": "Desc"}).json()
    r = c.post(f"/api/jobs/{j['id']}/fit", json={"engine": "local"})
    assert r.status_code == 400 and "Ollama" in r.json()["detail"]


def test_local_strips_thinking(monkeypatch):
    from app import ai, config
    monkeypatch.setattr(config, "OLLAMA_URL", "http://ollama.test:11434")

    class R:
        status_code = 200
        text = ""
        def raise_for_status(self): pass
        def json(self): return {"message": {"content": "<think>hmm</think>\n{\"score\": 7}"}}
    sent = {}
    monkeypatch.setattr(ai.httpx, "post", lambda url, json, timeout: sent.update(json) or R())
    out = ai._ask_local("sys", "user", 100, True)
    assert out == '{"score": 7}' and sent["format"] == "json" and sent["think"] is False
    assert sent["options"]["num_ctx"] >= 8192


def test_nightly_settings_and_run(c, monkeypatch):
    from app import ai, nightly
    from app.db import SessionLocal
    monkeypatch.setattr(ai, "available", lambda e: True)
    monkeypatch.setattr(ai, "_ask", lambda system, user, max_tokens=0, engine=None, json_mode=False:
                        '{"score": 6, "verdict": "OK", "strengths": [], "gaps": [], "keywords": []}'
                        if json_mode else "# Me\nx\n\n## Professional Experience\n### A | 2020 - 2021\n- y\n")
    me = c.get("/api/session").json()["user"]
    s = c.get("/api/nightly").json()
    assert s["settings"]["enabled"] is False and s["settings"]["run_time"] == "01:00"
    assert c.patch("/api/nightly", json={"run_time": "25:00"}).status_code == 422
    s = c.patch("/api/nightly", json={"enabled": True, "engine": "local", "do_fit": True}).json()
    assert s["settings"]["enabled"] and s["settings"]["engine"] == "local"
    if not c.get("/api/personas").json():
        c.post("/api/personas", json={"name": "Main", "resume_text": "My resume"})
    j = c.post("/api/jobs", json={"title": "Night job", "description": "Needs a resume", "url": "https://n.example/1"}).json()
    other = c.post("/api/jobs", json={"title": "Not picked", "description": "Leave me alone"}).json()
    bare = c.post("/api/jobs", json={"title": "No description"}).json()

    # nothing is made unless it's on the list
    assert c.get("/api/nightly").json()["pending"]["jobs"] == 0
    r = c.post("/api/nightly/queue", json={"job_ids": [j["id"], bare["id"]], "queued": True}).json()
    assert r["changed"] == 1 and r["pending"]["queued"] == 1 and r["pending"]["resume"] == 1
    assert c.patch(f"/api/jobs/{bare['id']}", json={"queued": True}).status_code == 400
    assert c.get(f"/api/jobs/{j['id']}").json()["queued"] is True

    run_id = nightly.run_for_user(me["id"], "manual")  # synchronous for the test
    runs = c.get("/api/nightly").json()["runs"]
    assert runs[0]["id"] == run_id and runs[0]["status"] == "done" and runs[0]["made"] == 2
    full = c.get(f"/api/jobs/{j['id']}").json()
    assert full["fit_score"] == 6 and full["queued"] is False  # done, so off the list
    doc = next(d for d in full["documents"] if d["kind"] == "resume")
    assert doc["nightly"] and doc["engine"].startswith("Local")
    assert next(x for x in c.get("/api/jobs").json() if x["id"] == j["id"])["has_resume"]
    assert c.get(f"/api/jobs/{other['id']}").json()["documents"] == []

    # list is empty now, so a second run makes nothing
    nightly.run_for_user(me["id"], "manual")
    assert sum(d["kind"] == "resume" for d in c.get(f"/api/jobs/{j['id']}").json()["documents"]) == 1

    # a failure keeps the job on the list for next time
    c.patch(f"/api/jobs/{other['id']}", json={"queued": True})
    monkeypatch.setattr(ai, "_ask", lambda *a, **k: (_ for _ in ()).throw(ai.AIError("model down")))
    nightly.run_for_user(me["id"], "manual")
    last = c.get("/api/nightly").json()["runs"][0]
    assert last["failed"] >= 1 and c.get(f"/api/jobs/{other['id']}").json()["queued"] is True
    c.post("/api/nightly/queue", json={"job_ids": [other["id"]], "queued": False})
    c.patch("/api/nightly", json={"enabled": False})
