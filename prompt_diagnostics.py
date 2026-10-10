"""Read-only prompt diagnostics. No model loading or attention prediction."""
import re

EMBEDDING_RE = re.compile(r"\bembedding:([^\s,()]+)")
EMBEDDING_EXTENSIONS = (".safetensors", ".pt", ".bin", ".ckpt")


def inspect_embeddings(text, available=None):
    names = list(dict.fromkeys(EMBEDDING_RE.findall(text)))
    known = set(available or [])
    result = []
    for name in names[:64]:
        filename = name if name in known else next((name + ext for ext in EMBEDDING_EXTENSIONS if name + ext in known), None)
        result.append({"name": name, "status": "unknown" if available is None else "found" if filename else "missing"})
    return result


def inspect_resolved_prompt(resolved, segments, available=None):
    weighted = [{"text": phrase, "weight": weight} for phrase, weight in segments if weight != 1.0][:64]
    return {"weights": weighted, "embeddings": inspect_embeddings(resolved, available),
            "weight_note": "Explicit numeric source weights, including multiplied nested weights. Encoder support and output formatting determine their effect.",
            "token_note": "CLIP-L reference tokenizer; not a measurement of the connected encoder. Embedding names are counted as text, without loading their vectors."}
