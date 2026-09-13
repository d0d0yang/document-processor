"""
app.py

Flask server that glues the frontend to blender.py. Simply one route 
to serve the page, one route to handle a scan.
"""

import os
import uuid

from flask import Flask, request, jsonify, send_from_directory

import blender

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/scan", methods=["POST"])
def scan():
    if "file" not in request.files:
        return jsonify({"error": "No file was uploaded."}), 400

    uploaded_file = request.files["file"]
    if uploaded_file.filename == "":
        return jsonify({"error": "No file was uploaded."}), 400

    # keywords arrive as comma deliminated strings
    raw_keywords = request.form.get("keywords", "")
    keywords = [k for k in raw_keywords.split(",") if k.strip()]

    user_prompt = request.form.get("prompt", "").strip()

    try:
        bias = float(request.form.get("bias", 1.0))
    except ValueError:
        bias = 1.0
    bias = max(0.0, min(1.0, bias))

    # give unique names to avoid coincidental overriding
    ext = os.path.splitext(uploaded_file.filename)[1]
    saved_name = f"{uuid.uuid4().hex}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, saved_name)
    uploaded_file.save(saved_path)

    try:
        outcome = blender.process_document(
            file_path=saved_path,
            keywords=keywords,
            user_prompt=user_prompt,
            bias=bias,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        # clean
        if os.path.exists(saved_path):
            os.remove(saved_path)

    return jsonify(outcome)


if __name__ == "__main__":
    app.run(debug=True, port=5000)