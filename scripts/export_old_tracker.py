"""Export everything from the OLD job-tracker (Postgres) into a Job Hacker backup file.

Run it inside the old backend container, which already has psycopg and DATABASE_URL:

    podman exec -i $(podman ps --format '{{.Names}}' | grep backend) \
        python - < scripts/export_old_tracker.py > old-tracker.json

(use `docker` instead of `podman` if that's what runs it). Then in the new app:
Settings → Import backup → pick old-tracker.json.

Mapping: users → profiles, personas → base resumes, category → tag,
status "Not started"→Saved, "In progress"→Applied, "Abandon"→Closed,
generated_documents → resumes / cover letters on each job.
"""
import datetime as dt
import json
import os
import sys

import psycopg

url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://")
conn = psycopg.connect(url)
cur = conn.cursor()


def cols(table):
    cur.execute("select column_name from information_schema.columns where table_name = %s", (table,))
    return {r[0] for r in cur.fetchall()}


def rows(sql, *args):
    cur.execute(sql, args)
    names = [d.name for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def iso(v):
    return v.isoformat() if isinstance(v, (dt.datetime, dt.date)) else v


has_users = bool(cols("users"))
users = rows("select id, name from users order by id") if has_users else [{"id": None, "name": "Me"}]
cat_cols = cols("categories")
job_cols = cols("jobs")
doc_cols = cols("generated_documents")
persona_cols = cols("personas")

out = {"format": "job-hacker", "version": 2, "exported_at": dt.datetime.utcnow().isoformat() + "Z",
       "source": "job-tracker", "profiles": []}

for u in users:
    uid = u["id"]
    where = " where user_id = %s" if (uid is not None and "user_id" in job_cols) else ""
    args = (uid,) if where else ()

    cats = {}
    if cat_cols:
        cw = " where user_id = %s" if (uid is not None and "user_id" in cat_cols) else ""
        cats = {c["id"]: c["name"] for c in rows("select id, name from categories" + cw, *((uid,) if cw else ()))}

    personas = []
    if persona_cols:
        pw = " where user_id = %s" if (uid is not None and "user_id" in persona_cols) else ""
        for p in rows("select * from personas" + pw + " order by id", *((uid,) if pw else ())):
            personas.append({"name": p.get("name") or "Resume", "resume_text": p.get("base_resume_text") or "",
                             "is_default": bool(p.get("is_default"))})

    jobs = []
    for j in rows("select * from jobs" + where + " order by id", *args):
        docs = []
        if doc_cols:
            for d in rows("select * from generated_documents where job_id = %s order by created_at", j["id"]):
                docs.append({"kind": d.get("doc_type") or "resume", "content": d.get("content_markdown") or "",
                             "created_at": iso(d.get("created_at"))})
        jobs.append({
            "url": j.get("source_url"), "title": j.get("title") or "(untitled)",
            "company": j.get("company") or "", "location": j.get("location") or "",
            "salary": j.get("salary") or "", "description": j.get("description") or "",
            "posted_date": j.get("posted_date") or "", "status": j.get("status") or "",
            "tags": cats.get(j.get("category_id"), ""), "source": "old-tracker",
            "created_at": iso(j.get("scraped_at")), "documents": docs,
        })
    out["profiles"].append({"name": u["name"], "preferences": "", "personas": personas, "jobs": jobs})

json.dump(out, sys.stdout, indent=1)
print(f"Exported {sum(len(p['jobs']) for p in out['profiles'])} jobs from {len(out['profiles'])} profile(s).",
      file=sys.stderr)
