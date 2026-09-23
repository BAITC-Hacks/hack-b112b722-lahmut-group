"""Render an approved meeting as a Word document."""

from io import BytesIO

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


def render_docx(meeting: dict) -> bytes:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Arial"
    normal.font.size = Pt(10)
    normal.paragraph_format.space_after = Pt(6)
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.left_margin = section.right_margin = Cm(2)
    section.top_margin = section.bottom_margin = Cm(2)
    title = doc.add_heading("Протокол встречи", 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if meeting["source_mode"] == "demo":
        doc.add_paragraph("ДЕМОНСТРАЦИОННЫЕ ВЫМЫШЛЕННЫЕ ДАННЫЕ")
    doc.add_paragraph(f"Тема: {meeting['title']}")
    doc.add_paragraph(f"Дата: {meeting['occurred_at']} ({meeting['timezone']})")
    doc.add_paragraph(f"Утверждённая редакция: {meeting['revision']}")
    if meeting["source_mode"] == "text":
        doc.add_paragraph("Источник: импорт текста. Временные метки 00:00 не привязаны к аудио.")

    doc.add_heading("Участники", 1)
    for participant in meeting["participants"]:
        speaker = participant.get("speaker_id")
        doc.add_paragraph(participant["display_name"] + (f" — {speaker}" if speaker else ""), style="List Bullet")
    if not meeting["participants"]:
        doc.add_paragraph("Участники не указаны.")

    doc.add_heading("Краткое содержание", 1)
    doc.add_paragraph(meeting["summary"] or "—")

    doc.add_heading("Поручения", 1)
    if meeting["actions"]:
        table = doc.add_table(rows=1, cols=5)
        table.style = "Table Grid"
        table.autofit = False
        widths = (0.8, 6.9, 3.2, 3.6, 2.5)
        for column, width in zip(table.columns, widths):
            column.width = Cm(width)
        header = OxmlElement("w:tblHeader")
        table.rows[0]._tr.get_or_add_trPr().append(header)
        for cell, heading in zip(table.rows[0].cells, ("№", "Поручение", "Ответственный", "Срок", "Статус")):
            cell.text = heading
        for i, action in enumerate(meeting["actions"], 1):
            row = table.add_row().cells
            for cell, value in zip(row, (str(i), action["title"], action["assignee"], _deadline(action), "Выполнено" if action["status"] == "done" else "В работе")):
                cell.text = value
        for index, row in enumerate(table.rows):
            for column_index, (cell, width) in enumerate(zip(row.cells, widths)):
                cell.width = Cm(width)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                properties = cell._tc.get_or_add_tcPr()
                fill = OxmlElement("w:shd")
                fill.set(qn("w:fill"), "234B60" if index == 0 else "F2F6F8" if index % 2 == 0 else "FFFFFF")
                properties.append(fill)
                borders = OxmlElement("w:tcBorders")
                for edge in ("top", "left", "bottom", "right"):
                    border = OxmlElement(f"w:{edge}")
                    for name, value in (("val", "single"), ("sz", "4"), ("color", "D9D9D9")):
                        border.set(qn(f"w:{name}"), value)
                    borders.append(border)
                properties.append(borders)
                margins = OxmlElement("w:tcMar")
                for edge in ("top", "left", "bottom", "right"):
                    margin = OxmlElement(f"w:{edge}")
                    margin.set(qn("w:w"), "90")
                    margin.set(qn("w:type"), "dxa")
                    margins.append(margin)
                properties.append(margins)
                for paragraph in cell.paragraphs:
                    paragraph.paragraph_format.space_after = Pt(3)
                    paragraph.paragraph_format.space_before = Pt(3)
                    if column_index == 0:
                        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    for run in paragraph.runs:
                        run.font.size = Pt(9)
                        if index == 0:
                            run.bold = True
                            run.font.color.rgb = RGBColor(255, 255, 255)
    else:
        doc.add_paragraph("Поручения не зафиксированы.")

    doc.add_heading("Основания в исходном материале", 1)
    evidence = {segment["id"]: segment for segment in meeting["segments"]}
    for i, action in enumerate(meeting["actions"], 1):
        if not action["evidence_segment_ids"]:
            continue
        doc.add_paragraph(f"Поручение {i}: {action['title']}")
        for segment_id in action["evidence_segment_ids"]:
            segment = evidence[segment_id]
            if meeting["source_mode"] == "audio":
                label = f"[{_clock(segment['start_ms'])}] {segment['speaker_id'] or 'Говорящий не определён'}"
            else:
                label = f"{segment['speaker_id'] or 'Говорящий не определён'} (без аудиометки)"
            doc.add_paragraph(f"{label}: {segment['text']}", style="List Bullet")

    doc.add_heading("Расшифровка", 1)
    names = {p["speaker_id"]: p["display_name"] for p in meeting["participants"] if p.get("speaker_id")}
    for segment in meeting["segments"]:
        speaker = names.get(segment["speaker_id"], segment["speaker_id"]) or "Говорящий не определён"
        stamp = f"[{_clock(segment['start_ms'])}–{_clock(segment['end_ms'])}] " if meeting["source_mode"] == "audio" else ""
        paragraph = doc.add_paragraph()
        paragraph.add_run(f"{stamp}{speaker}: ").bold = True
        paragraph.add_run(segment["text"])

    if meeting["warnings"]:
        doc.add_heading("Примечания", 1)
        for warning in meeting["warnings"]:
            doc.add_paragraph(warning, style="List Bullet")
    output = BytesIO()
    doc.save(output)
    return output.getvalue()


def _deadline(action: dict) -> str:
    raw = action["due_text"] or "Не указан"
    due = action["due_date"]
    if due:
        return due if raw == due else f"{due}\nИсходный срок: {raw}"
    return f"Дата не указана\n{raw}"


def _clock(milliseconds: int) -> str:
    seconds = milliseconds // 1000
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"
