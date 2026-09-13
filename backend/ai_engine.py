"""
ai_engine.py

The AI half of the pipeline. Essentially just uploads a file and asks 
Gemini 3.5-flash a question passed by Flask along keywords / OCR hints / 
a bias level.
"""

import os
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()
gemini_api_key = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=gemini_api_key)

SYSTEM_PROMPT_PATH = os.path.join(os.path.dirname(__file__), "system_prompt.txt")
with open(SYSTEM_PROMPT_PATH, "r") as file:
    system_prompt = file.read()

MODEL_NAME = "gemini-3.5-flash"


def bias_instruction(bias, has_keywords):
    """
    Turn slider values into plain-language Gemini reads. Gemini is sent both 
    a prompt and the raw float representing how skeptical to be of the OCR 
    candidates.
    """
    if not has_keywords:
        return (
            "No keywords were provided, so OCR was not run. You have full "
            "discretion to extract whatever is relevant from the document."
        )

    pct_ai = round(bias * 100)
    pct_ocr = 100 - pct_ai

    if bias <= 0.05:
        stance = (
            "Treat the OCR candidates below as close to absolute truth. Only "
            "override one if it is obviously garbled, mismatched, or missing."
        )
    elif bias >= 0.95:
        stance = (
            "Treat the OCR candidates below skeptically. Use them only in case "
            "of a tiebreaker or if your reading is unclear."
        )
    else:
        stance = (
            "Weigh the OCR candidates against your own reading of the "
            "document with the bias serving as a benchmark of reliability. "
            "When readings agree, use that answer with confidence. "
            "When readings disagree, pick whichever fits the surrounding "
            "context better, giving more confidence according to whomever "
            "has greater bias, and flag the disagreement in the value."
        )

    return (
        f"Bias for this request: {pct_ai}% AI discretion / {pct_ocr}% OCR trust. "
        + stance
    )


def format_ocr_candidates(ocr_results):
    """
    Turn the ocr_engine output into a readable block Gemini can reference
    alongside the document. Keeps it plain text - no need to hand it JSON
    for something this small.
    """
    if not ocr_results:
        return "No OCR candidates available."

    lines = []
    for keyword, match in ocr_results.items():
        if match["value"] is None:
            lines.append(f"- {keyword}: [OCR found nothing nearby]")
        else:
            lines.append(
                f"- {keyword}: \"{match['value']}\" "
                f"(match confidence {match['confidence']}, "
                f"found near: \"{match['context']}\")"
            )
    return "\n".join(lines)


def build_user_prompt(user_prompt, keywords, ocr_results, bias):
    """
    Assemble everything the user/OCR side contributed into the single
    text block that goes to Gemini alongside the file.
    """
    has_keywords = bool(keywords)
    sections = []

    if user_prompt:
        sections.append(f"User's request: {user_prompt}")

    if has_keywords:
        sections.append("Keywords to extract: " + ", ".join(keywords))
        sections.append("OCR candidates:\n" + format_ocr_candidates(ocr_results))
    else:
        sections.append(
            "No keywords were provided - extract using full discretion."
        )

    sections.append(bias_instruction(bias, has_keywords))

    return "\n\n".join(sections)


def call_gemini(file_path, user_prompt, keywords, ocr_results, bias):
    """
    Upload the document and ask Gemini to extract from it, with the
    OCR hints and bias instruction folded into the prompt text.
    """
    my_file = client.files.upload(file=file_path)

    try:
        full_prompt = build_user_prompt(user_prompt, keywords, ocr_results, bias)

        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=[my_file, full_prompt],
            config=types.GenerateContentConfig(
                temperature=0.3,
                system_instruction=system_prompt,
            ),
        )

        return response.text
    finally:
        # clean
        client.files.delete(name=my_file.name)