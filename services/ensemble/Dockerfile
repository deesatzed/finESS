# finESS ensemble sidecar.
#
# Build context expectation:
#   docker compose builds with context = repo root so we can COPY both this
#   service directory AND the sibling ace_hospital source tree (mounted via
#   docker-compose.yml at build time).
#
# This image installs the full numeric stack (numpy/pandas/scipy/statsmodels
# /scikit-learn/xgboost). Chronos (torch + chronos-forecasting) is NOT
# installed by default to keep the image small and the cold-start fast;
# set ENSEMBLE_LOAD_CHRONOS=1 and rebuild with the chronos extras to enable.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps required by scipy/statsmodels/xgboost wheels at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the sidecar's own deps first (cached layer).
COPY services/ensemble/requirements.txt /app/requirements.txt
RUN pip install --upgrade pip \
    && pip install -r /app/requirements.txt

# Install the upstream ensemble. ace_hospital is mounted at /opt/ace_hospital
# by docker-compose (volume) OR baked in via build context if you uncomment
# the next two lines.
# COPY aXc11426 /opt/ace_hospital
# RUN pip install --no-deps -e /opt/ace_hospital

# Copy the sidecar source.
COPY services/ensemble /app/services/ensemble

# Expose FastAPI port.
EXPOSE 8001

# Health probe used by docker-compose.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
    CMD curl -fsS http://localhost:8001/health || exit 1

# Single worker on purpose: the in-process EnsembleRegistry is not yet
# distributed (R6-06 will tackle persistence + multi-worker).
CMD ["uvicorn", "services.ensemble.app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
