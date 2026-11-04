from app.docx_export import to_docx
from app.resume_format import role_dates, sort_experience, to_plain

MD = """# Jane Doe
jane@x.com | Singapore
Scrum Master | Agile Coach

## Professional Summary
Summary here.

## Professional Experience
### Citibank | June 2022 – October 2023
**Scrum Master**
- Did things

### Acme | Jan 2024 – Present
**Agile Coach**
- Now things

### SIA | 2014 – 2021
**Product Owner**
- Old things

## Certifications & Education
- **Certifications:** CSM
"""


def test_role_dates():
    assert role_dates("Citibank | June 2022 – October 2023") == ((2023, 10), (2022, 6))
    assert role_dates("Acme | Jan 2024 – Present")[0] == (9999, 12)
    assert role_dates("SIA | 2014 - 2021") == ((2021, 12), (2014, 1))
    assert role_dates("No dates here") is None


def test_sort_experience_newest_first_and_keeps_other_sections():
    out = sort_experience(MD)
    roles = [l for l in out.splitlines() if l.startswith("### ")]
    assert [r.split(" |")[0] for r in roles] == ["### Acme", "### Citibank", "### SIA"]
    assert out.index("## Professional Summary") < out.index("## Professional Experience") < out.index("## Certifications")
    assert "- Now things" in out and "**Scrum Master**" in out
    assert sort_experience("no headings at all") == "no headings at all"


def test_plain_and_docx():
    plain = to_plain(MD)
    assert "PROFESSIONAL EXPERIENCE" in plain and "• Did things" in plain and "**" not in plain and "#" not in plain
    assert to_docx(sort_experience(MD), "resume")[:2] == b"PK"
    assert to_docx("Dear team,\n\nI'd love to help.\n\nBest,\nJane", "cover_letter")[:2] == b"PK"
