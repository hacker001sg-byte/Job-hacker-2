"""Everything that talks to Claude. All features degrade gracefully when
ANTHROPIC_API_KEY isn't set — the UI hides the buttons."""
from __future__ import annotations

import json
import re

from . import config

_client = None


class AIError(Exception):
    pass


def enabled() -> bool:
    return bool(config.ANTHROPIC_API_KEY)


def _get_client():
    global _client
    if _client is None:
        from anthropic import Anthropic
        _client = Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def _ask(system: str, user: str, max_tokens: int = 2000) -> str:
    if not enabled():
        raise AIError("AI features are off. Add ANTHROPIC_API_KEY to your .env to turn them on.")
    try:
        resp = _get_client().messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except Exception as e:  # network, auth, rate limit…
        raise AIError(f"Claude request failed: {e.__class__.__name__}: {e}") from e
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()


def _json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise AIError("Claude didn't return the expected format. Try again.")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise AIError("Claude didn't return the expected format. Try again.") from e


def _job_block(job) -> str:
    g = (lambda k: getattr(job, k, None) if not isinstance(job, dict) else job.get(k))
    return (
        f"Job title: {g('title') or 'n/a'}\n"
        f"Company: {g('company') or 'n/a'}\n"
        f"Location: {g('location') or 'n/a'}\n"
        f"Salary: {g('salary') or 'n/a'}\n\n"
        f"Job description:\n{g('description') or '(no description saved)'}\n"
    )


# ---------- extraction ----------

EXTRACT_SYSTEM = """You extract job posting details from messy text copied off a web page.
Return ONLY a JSON object with these string keys:
title, company, location, salary, employment_type, posted_date, description.
Rules:
- Use "" for anything not stated. Never guess a company or salary.
- posted_date: YYYY-MM-DD if a date is given, otherwise the text as written (e.g. "3 days ago"), else "".
- description: the full job description (responsibilities, requirements, benefits, about the company)
  as clean plain text with "- " bullets and blank lines between sections. Drop navigation, cookie
  banners, "similar jobs", sign-in prompts and other page chrome. Do not summarise or shorten it."""


def extract_job(text: str, hint_title: str = "") -> dict:
    user = (f"Page title: {hint_title}\n\n" if hint_title else "") + f"TEXT:\n{text}"
    data = _json(_ask(EXTRACT_SYSTEM, user, max_tokens=4000))
    return {k: str(data.get(k) or "").strip() for k in
            ("title", "company", "location", "salary", "employment_type", "posted_date", "description")}


# ---------- fit score ----------

FIT_SYSTEM = """You are a frank career advisor. Score how well a candidate fits a job, 1–10.
10 = they meet essentially every requirement and it matches what they want.
7 = solid match worth applying, a few gaps. 4 = stretch. 1 = clearly wrong role.
If anything in the candidate's stated dealbreakers applies, score 2 or lower and say which.
Return ONLY JSON:
{"score": <int 1-10>,
 "verdict": "<one plain sentence, max 25 words>",
 "strengths": ["<max 4 short points, each tied to real resume evidence>"],
 "gaps": ["<max 4 short points: missing requirements or concerns>"],
 "keywords": ["<up to 8 terms from the posting worth mirroring in the resume>"]}"""


def fit(resume: str, preferences: str, job) -> dict:
    user = (
        f"CANDIDATE RESUME:\n{resume or '(none provided)'}\n\n"
        f"WHAT THE CANDIDATE WANTS / DEALBREAKERS:\n{preferences or '(not specified)'}\n\n"
        f"JOB:\n{_job_block(job)}"
    )
    d = _json(_ask(FIT_SYSTEM, user, max_tokens=1200))
    try:
        d["score"] = max(1, min(10, int(d.get("score", 0))))
    except (TypeError, ValueError):
        raise AIError("Claude didn't return a score. Try again.")
    for k in ("strengths", "gaps", "keywords"):
        d[k] = [str(x) for x in (d.get(k) or [])][:8]
    d["verdict"] = str(d.get("verdict") or "")
    return d


# ---------- documents ----------

RESUME_SYSTEM = """You are an expert resume writer. You get a candidate's base resume and a target
job. Produce a tailored resume in the exact Markdown structure below — nothing else.

# Full Name
email | phone | city | website
Headline 1 | Headline 2 | Headline 3

## Professional Summary
One paragraph, 3–5 sentences, written for this role.

## Core Capabilities
- **Group name:** item, item, item

## Professional Experience
### Company | Month YYYY – Month YYYY
**Job Title — Team or Department**
- Achievement bullet
- Achievement bullet

## Certifications & Education
- **Certifications:** ...
- **Education:** ...

## Tools & Technology
Comma-separated list.

Hard rules:
- ROLE ORDER IS FIXED: list every role in reverse chronological order (most recent first),
  with the same companies, titles and dates as the base resume. Never move a role up or down
  because it is more relevant, and never drop a role. Older roles may be shortened to 1–2 bullets.
- Within a role you MAY reorder, reword and trim bullets to mirror the job's language and
  priorities. You MAY rewrite the summary, headlines and capability groups for this role.
- Never invent employers, titles, dates, certifications, tools or metrics.
- Write past roles in past tense and the current role (end date "Present") in present tense.
- Use only the markers shown: #, ##, ###, "- " bullets and **bold**. No tables, no horizontal
  rules, no decorative symbols (❖ ▪ • ★ etc.) — remove any that appear in the base resume.
- Contact and headline lines separate items with " | ".
- Keep it to about two pages; cut the least relevant bullets first.
- Output ONLY the resume."""

COVER_SYSTEM = """You are an expert cover letter writer. You get a candidate's resume and a target
job. Write a specific cover letter under 350 words as clean plain text — no Markdown.

Rules:
- Open with something specific to this role or company, not "I am writing to express my interest".
- Reference concrete details from the posting (team, product, requirements).
- Use only real experience from the resume; never fabricate.
- Plain, confident, warm tone. Short paragraphs.
- Output ONLY the letter (greeting to sign-off)."""


def tailor_resume(resume: str, job, extra: str = "") -> str:
    if not resume.strip():
        raise AIError("Add your base resume in Settings first.")
    user = f"BASE RESUME:\n{resume}\n\nTARGET JOB:\n{_job_block(job)}"
    if extra.strip():
        user += f"\n\nEXTRA INSTRUCTIONS FROM THE CANDIDATE:\n{extra}"
    from .resume_format import sort_experience
    out = _ask(RESUME_SYSTEM, user, max_tokens=4000)
    out = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", out.strip())
    return sort_experience(out)


def cover_letter(resume: str, job, extra: str = "") -> str:
    if not resume.strip():
        raise AIError("Add your base resume in Settings first.")
    user = f"RESUME:\n{resume}\n\nTARGET JOB:\n{_job_block(job)}"
    if extra.strip():
        user += f"\n\nEXTRA INSTRUCTIONS FROM THE CANDIDATE:\n{extra}"
    return _ask(COVER_SYSTEM, user, max_tokens=1500)
