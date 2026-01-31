from flask import Flask, request, jsonify, send_from_directory
import torch
import cv2
import numpy as np
from PIL import Image
import base64
import io
import uuid
import json

app = Flask(__name__, static_folder='.')

# Load the PyTorch model once when the server starts
try:
    model = torch.hub.load('ultralytics/yolov5', 'custom', path='best.pt')
    model.eval()
    print("Model 'best.pt' loaded successfully.")
except Exception as e:
    print(f"Error loading model: {e}")
    model = None

# In-memory storage for detection data for the current session.
session_detections = {}

def process_image_with_model(img_np, redaction_rules):
    """
    Processes a NumPy image array with the loaded model and applies redaction based on rules.
    """
    if model is None:
        return None, "Model is not loaded."

    # Run inference
    results = model(img_np)
    detections = []
    
    redacted_img_np = img_np.copy()

    # Process results to get detections
    for *box, conf, cls in results.xyxy[0]:
        pii_class = model.names[int(cls)]

        # Apply redaction rules from the frontend
        if redaction_rules.get(pii_class, True):
            detection_id = str(uuid.uuid4())
            detections.append({
                'id': detection_id,
                'class': pii_class,
                'bbox': [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                'original_value': 'REDACTED_FOR_DEMO'
            })
            
            # Store detection for later reveal
            session_detections[detection_id] = {
                'class': pii_class,
                'value': 'This is a demo value for PII', 
            }
            
            # Draw a black box over the PII area on the image
            cv2.rectangle(redacted_img_np, (int(box[0]), int(box[1])), (int(box[2]), int(box[3])), (0, 0, 0), -1)

    return redacted_img_np, detections

@app.route('/')
def home():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@app.route('/api/redact-static', methods=['POST'])
def redact_static():
    if 'image_file' not in request.files:
        return jsonify({'error': 'No image file provided.'}), 400

    file = request.files['image_file']
    if not file:
        return jsonify({'error': 'Invalid file.'}), 400
    
    redaction_rules_json = request.form.get('session_redaction_rules', '{}')
    try:
        redaction_rules = json.loads(redaction_rules_json)
    except json.JSONDecodeError:
        redaction_rules = {}

    img = Image.open(file.stream).convert('RGB')
    img_np = np.array(img)

    redacted_img_np, detections = process_image_with_model(img_np, redaction_rules)
    
    if redacted_img_np is None:
        return jsonify({'error': detections}), 500

    _, buffer = cv2.imencode('.jpg', redacted_img_np)
    redacted_image_b64 = base64.b64encode(buffer).decode('utf-8')

    return jsonify({
        'redacted_image': redacted_image_b64,
        'detections': detections,
        'total_detections': len(detections)
    })

@app.route('/api/reveal/<detection_id>', methods=['GET'])
def reveal_pii(detection_id):
    detection = session_detections.get(detection_id)
    if not detection:
        return jsonify({'error': 'Detection ID not found.'}), 404
    
    return jsonify({
        'original_value': detection['value']
    })

if __name__ == '__main__':
    app.run(debug=True)