import io
import re

from docx import Document
from docx.shared import Pt


def to_docx(text: str) -> bytes:
    """Plain text (or light Markdown) → a clean .docx."""
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(4)

    lines = text.splitlines()
    for i, raw in enumerate(lines):
        line = raw.rstrip()
        if not line.strip():
            continue
        md = re.match(r"^(#{1,3})\s+(.*)", line)
        if md:
            doc.add_heading(md.group(2), level=len(md.group(1)))
            continue
        if re.match(r"^\s*[-*•]\s+", line):
            doc.add_paragraph(re.sub(r"^\s*[-*•]\s+", "", line), style="List Bullet")
            continue
        clean = re.sub(r"\*\*(.*?)\*\*", r"\1", line)
        # Treat a short line with no ending punctuation, followed by content, as a section header.
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        is_header = (
            len(clean) <= 40 and not clean.endswith((".", ",", ":", ";")) and i > 2 and nxt
            and (clean.isupper() or clean.istitle()) and not re.search(r"\d{4}", clean)
        )
        if is_header:
            p = doc.add_paragraph()
            r = p.add_run(clean)
            r.bold = True
            r.font.size = Pt(12.5)
            p.paragraph_format.space_before = Pt(10)
        else:
            doc.add_paragraph(clean)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
