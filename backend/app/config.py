import logging
import os
import warnings

from pydantic import BaseModel

from app.limits import (
    DEFAULT_ORCA_JOB_TTL_SECONDS,
    DEFAULT_ORCA_MAX_PENDING_REQUESTS,
    DEFAULT_ORCA_RAM_CEILING_MB,
)


# TensorFlow is imported lazily by the CASCADE model builder. Set these before
# Keras/TensorFlow loads so Windows startup stays quieter and deterministic.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
warnings.filterwarnings(
    "ignore",
    message=r"TensorFlow GPU support is not available on native Windows.*",
)
logging.getLogger("tensorflow").setLevel(logging.ERROR)

try:
    from absl import logging as absl_logging
except ImportError:
    absl_logging = None
else:
    absl_logging.set_verbosity(absl_logging.ERROR)
    absl_logging.set_stderrthreshold("error")


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_CDK_DIR = os.path.join(_BACKEND_DIR, "vendor", "cdk")


class Settings(BaseModel):
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    cdk_jar_path: str = os.getenv("CDK_JAR_PATH", _DEFAULT_CDK_DIR)
    # Path to the CASCADE model assets — the directory that contains
    # ``preprocessor.p`` and ``trained_model/`` from the patonlab/CASCADE
    # repo. Defaults to the vendored copy under ``backend/vendor/``.
    cascade_path: str = os.getenv(
        "CASCADE_PATH",
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "vendor",
            "cascade",
            "CASCADE",
            "cascade-Jupyternotebook-SMILES",
            "models",
            "cascade",
        ),
    )
    work_dir: str = os.getenv("NMR_WORK_DIR", os.path.join(os.getcwd(), "_work"))

    # ORCA (QM engine) configuration. Cheap defaults — override via env
    # for production accuracy (e.g. ``! B97-D3 pcS-seg-1 NMR``).
    orca_exe: str = os.getenv("ORCA_EXE", r"C:\ORCA_6.1.1\orca.exe")
    orca_functional: str = os.getenv("ORCA_FUNCTIONAL", "PBE")
    orca_basis: str = os.getenv("ORCA_BASIS", "def2-SVP")
    orca_cpus: int = int(os.getenv("ORCA_CPUS", "4"))
    orca_ram_mb: int = int(os.getenv("ORCA_RAM_MB", "2000"))
    # Where ORCA job dirs and the TMS reference cache live.
    orca_work_dir: str = os.getenv(
        "ORCA_WORK_DIR",
        os.path.join(os.getcwd(), "_work", "orca"),
    )
    orca_timeout_seconds: int = int(os.getenv("ORCA_TIMEOUT", "600"))
    orca_max_pending_requests: int = int(
        os.getenv("ORCA_MAX_PENDING_REQUESTS", str(DEFAULT_ORCA_MAX_PENDING_REQUESTS))
    )
    orca_job_ttl_seconds: int = int(
        os.getenv("ORCA_JOB_TTL_SECONDS", str(DEFAULT_ORCA_JOB_TTL_SECONDS))
    )
    orca_ram_ceiling_mb: int = int(
        os.getenv("ORCA_RAM_CEILING_MB", str(DEFAULT_ORCA_RAM_CEILING_MB))
    )


settings = Settings()
os.makedirs(settings.work_dir, exist_ok=True)
os.makedirs(settings.orca_work_dir, exist_ok=True)
