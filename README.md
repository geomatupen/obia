# OBIA Workflow (Phase 2)

This project provides a **general-purpose OBIA (Object-Based Image Analysis) workflow** that works with any raster imagery.  
It uses the [NickySpatial](https://github.com/nickyspatial) library for segmentation and supervised classification (Random Forest, SVM, KNN), combined with a **FastAPI backend** and a **Leaflet-based web UI** for an end-to-end pipeline.
This video sums up the overall workflow on how it works: https://drive.google.com/file/d/1kbkMGpdV6UeogWRjpqjGZD-2Hxu5dwaV/view?usp=sharing
---

# What this repo includes
- **Backend** (`app.py`) — FastAPI server for raster upload, segmentation, samples, classification, and serving results  
- **Frontend** (`index.html`, `main.js`) — Leaflet-based UI to manage layers, run segmentation, pick samples, classify, and visualize results  
- **Results directories** auto-created for segments, samples, and classifications  
- **environment.yaml** — conda environment file for reproducibility  

---

# Running locally

## 1. Setup backend
Open a terminal, go to the backend folder:

    cd backend

Create a virtual environment:

    python -m venv venv
    source venv/bin/activate   # Linux/Mac
    venv\Scripts\activate      # Windows

Install dependencies (or use `environment.yaml`):

    pip install -r requirements.txt
    # or
    conda env create -f environment.yaml
    conda activate obia

Run the FastAPI server:

    uvicorn app:app --workers 4 --port 8001

The backend will now be available at `http://127.0.0.1:8001`.

---

## 2. Setup frontend
Open the frontend `index.html` in a browser.  
If you are using VS Code, you can right-click and **Open with Live Server** to serve it on a different port (e.g., `http://127.0.0.1:5500`).  
 
This UI provides four main tabs:
- **Layers**: Upload rasters or load existing GeoJSONs  
- **Segment**: Choose raster, set parameters (scale, compactness), run segmentation  
- **Samples**: Define classes, click on objects to assign them, save as JSON  
- **Classification**: Run RF, SVM, or KNN on the labeled samples and visualize results   

---

# Results
- Segments are saved under `results/segments/`  
- Samples under `results/samples/`  
- Classified outputs under `results/classify/`  
- Results can be styled and viewed directly in the web UI  
