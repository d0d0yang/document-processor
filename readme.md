# Document Processor

A document scanner that pulls keyword/value pairs out of PDFs, images, and other text-based files. Choose how much extraction comes from raw OCR versus LLM processing with a single slider.

## Functionality

Select a document and type in the chosen keywords (invoice #, last name, etc). A slider controls the balance between two extraction methods:

- **Manual (OCR)**: reads the document directly and finds values sitting next to keywords based on position on the page.
- **AI (Gemini)**: reads the whole document and independently finds what you're asking for.

No keywords locks manual mode, since there's nothing for OCR to search for. Set the slider all the way to manual and it runs entirely with no server or API call.

Results come out in a 'keyword: value' format and can be downloaded as JSON, CSV, or plain text TXT.

## Personal Setup

You'll need Python 3.10+ and an active Gemini API key (free).

```
git clone https://github.com/d0d0yang/document-processor.git
cd document-processor
pip install -r requirements.txt
```

Create a `.env` file in `backend/` with your key:

```
GEMINI_API_KEY=your_key_here
```

Run it:

```
cd backend
python app.py
```

Open `http://localhost:5000`.

Note: EasyOCR downloads its model the first time you run a scan that needs it, so the first request will be slow.

## Project Structure

```
backend/
  app.py            Flask server, routes requests to blender.py
  blender.py         decides bias for OCR vs AI based on the slider
  ocr_engine.py       reads documents and matches keywords to nearby text
  ai_engine.py         talks to Gemini
  system_prompt.txt    LLM instructions

frontend/
  index.html         page structure
  style.css           styling
  script.js            handles form, slider, and OCR when complete manual
```

## Tools

Flask, PyMuPDF, EasyOCR, rapidfuzz, and the Gemini API on the backend. Plain HTML/CSS/JS on the frontend, no framework, with pdf.js and Tesseract.js for the browser side OCR.

## Known Limitations

- Manual mode's keyword matching is fuzzy but not perfect. It looks for values to the right of a keyword, or on the line below, which covers most but not all forms of document.
- EasyOCR runs on CPU by default. Scanned documents take a few seconds longer than ones with real text.


Note this is a personal project built strictly for educational purposes rather than a proper production tool. Results may be inaccurate, incomplete, or misleading. Use at your own risk.