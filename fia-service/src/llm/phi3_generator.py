"""
Phi-3-mini-4k-instruct text generator.

The class encapsulates the HuggingFace stack so the rest of the service can
treat report generation as a single `generate(event) -> InvestigationReport`
call. If the heavy ML stack is unavailable (no GPU + slow CPU + missing
weights), `FALLBACK_ON_LLM_FAILURE=true` lets us degrade to a deterministic
rule-based report so the pipeline still produces something parseable.
"""

import json
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from src.llm.prompt import build_prompt
from src.llm.report_schema import InvestigationReport, ValidationError
from src.utils.logger import get_logger

logger = get_logger("FIA.llm")


class Phi3ReportGenerator:
    def __init__(self, config):
        self._config = config
        self._pipeline = None
        self._model_id: str = config.LLM_MODEL_PATH or config.LLM_MODEL_NAME
        self._fallback_only = False
        self._init_model()

    # ─────────────────────────────────────────────────────────
    # Setup
    # ─────────────────────────────────────────────────────────
    def _init_model(self) -> None:
        try:
            import torch  # type: ignore
            from transformers import (  # type: ignore
                AutoModelForCausalLM,
                AutoTokenizer,
                pipeline,
            )
        except ImportError as e:
            if self._config.FALLBACK_ON_LLM_FAILURE:
                logger.warning(
                    "transformers/torch not importable (%s) - falling back to rule-based reports", e
                )
                self._fallback_only = True
                return
            raise

        try:
            device = self._resolve_device(torch)
            dtype = self._resolve_dtype(torch, device)
            logger.info("Loading LLM '%s' on device=%s dtype=%s", self._model_id, device, dtype)

            tokenizer = AutoTokenizer.from_pretrained(self._model_id, trust_remote_code=True)

            # Phi-3 ships flash-attention kernels that only run on CUDA. MPS
            # and CPU need attn_implementation="eager" or model loading errors
            # with "FlashAttention2 has been toggled on, but it cannot be used".
            attn_impl = "flash_attention_2" if device == "cuda" else "eager"
            model = AutoModelForCausalLM.from_pretrained(
                self._model_id,
                torch_dtype=dtype,
                trust_remote_code=True,
                attn_implementation=attn_impl,
            )

            # Move to target device manually instead of using `device_map`,
            # which requires `accelerate` and behaves inconsistently on MPS.
            if device != "cpu":
                model = model.to(device)

            self._pipeline = pipeline(
                "text-generation",
                model=model,
                tokenizer=tokenizer,
                device=device,
            )
            logger.info("LLM '%s' loaded", self._model_id)
        except Exception as e:
            if self._config.FALLBACK_ON_LLM_FAILURE:
                logger.warning(
                    "LLM load failed (%s) - falling back to rule-based reports", e, exc_info=True
                )
                self._fallback_only = True
            else:
                raise

    def _resolve_device(self, torch) -> str:
        configured = (self._config.LLM_DEVICE or "auto").lower()
        if configured == "auto":
            if torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return "mps"
            return "cpu"
        return configured

    def _resolve_dtype(self, torch, device: str):
        configured = (self._config.LLM_DTYPE or "auto").lower()
        if configured == "auto":
            # fp16 is well-supported on both CUDA and MPS; CPU needs fp32 to
            # avoid the "addmm_impl_cpu_ not implemented for 'Half'" error.
            return torch.float16 if device in ("cuda", "mps") else torch.float32
        if configured in {"float16", "fp16"}:
            return torch.float16
        if configured in {"bfloat16", "bf16"}:
            return torch.bfloat16
        return torch.float32

    # ─────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────
    def model_version(self) -> str:
        suffix = "-fallback" if self._fallback_only else ""
        return f"{self._model_id}{suffix}"

    def generate(self, event: Dict[str, Any]) -> Tuple[InvestigationReport, int]:
        """
        Generate a report. Returns (report, latency_ms).
        Falls back to a deterministic rule-based report if the LLM is unavailable
        or its output cannot be parsed (only when FALLBACK_ON_LLM_FAILURE is true).
        """
        start = time.time()

        if self._fallback_only:
            report = self._rule_based_report(event)
            return report, int((time.time() - start) * 1000)

        prompt = build_prompt(event, self._config.PROMPT_TEMPLATE_VERSION)
        try:
            raw = self._run_pipeline(prompt)
            report = self._parse(raw)
            return report, int((time.time() - start) * 1000)
        except Exception as e:
            logger.warning("LLM generation/parse failed: %s", e)
            if not self._config.FALLBACK_ON_LLM_FAILURE:
                raise
            report = self._rule_based_report(event)
            return report, int((time.time() - start) * 1000)

    # ─────────────────────────────────────────────────────────
    # Internals
    # ─────────────────────────────────────────────────────────
    def _run_pipeline(self, prompt: str) -> str:
        assert self._pipeline is not None
        out = self._pipeline(
            prompt,
            max_new_tokens=self._config.LLM_MAX_NEW_TOKENS,
            do_sample=self._config.LLM_TEMPERATURE > 0,
            temperature=max(self._config.LLM_TEMPERATURE, 1e-5),
            return_full_text=False,
            pad_token_id=self._pipeline.tokenizer.eos_token_id,
        )
        if not out:
            raise RuntimeError("Empty pipeline output")
        return out[0]["generated_text"]

    @staticmethod
    def _extract_json_blob(text: str) -> Optional[str]:
        """Pull the first {...} JSON object out of a free-form LLM response."""
        match = re.search(r"\{.*\}", text, re.DOTALL)
        return match.group(0) if match else None

    def _parse(self, raw: str) -> InvestigationReport:
        blob = self._extract_json_blob(raw)
        if blob is None:
            raise ValueError("No JSON object found in LLM output")
        data = json.loads(blob)
        try:
            return InvestigationReport(**data)
        except ValidationError as e:
            raise ValueError(f"Schema validation failed: {e}") from e

    # ─────────────────────────────────────────────────────────
    # Conversational follow-up
    # ─────────────────────────────────────────────────────────
    def chat(
        self,
        report: Dict[str, Any],
        history: List[Dict[str, str]],
        user_message: str,
    ) -> Tuple[str, int]:
        """
        Multi-turn follow-up grounded in an existing report.

        `history` is the prior conversation as a list of
        `{role: "user"|"assistant", content: str}` entries. The
        returned tuple is `(answer, latency_ms)`. When the LLM is
        unavailable we degrade to a deterministic templated answer
        so the UI still has something to render.
        """
        start = time.time()

        if self._fallback_only or self._pipeline is None:
            answer = self._rule_based_chat(report, user_message)
            return answer, int((time.time() - start) * 1000)

        prompt = self._build_chat_prompt(report, history, user_message)
        try:
            raw = self._run_pipeline(prompt)
            answer = raw.strip()
            if not answer:
                raise RuntimeError("Empty chat answer")
            return answer, int((time.time() - start) * 1000)
        except Exception as e:
            logger.warning("LLM chat failed: %s", e)
            if not self._config.FALLBACK_ON_LLM_FAILURE:
                raise
            return self._rule_based_chat(report, user_message), int((time.time() - start) * 1000)

    @staticmethod
    def _build_chat_prompt(
        report: Dict[str, Any], history: List[Dict[str, str]], user_message: str
    ) -> str:
        lines = [
            "You are a fraud investigation assistant grounded in the report below.",
            "Answer follow-up questions concisely. Cite the report when relevant.",
            "",
            "REPORT:",
            f"- verdict: {report.get('verdict')}",
            f"- recommended_action: {report.get('recommendedAction') or report.get('recommended_action')}",
            f"- confidence: {report.get('agentConfidence') or report.get('agent_confidence')}",
            f"- narrative: {report.get('narrative')}",
            f"- key_indicators: {report.get('keyIndicators') or report.get('key_indicators')}",
            "",
            "CONVERSATION:",
        ]
        for turn in history:
            role = turn.get("role", "user").upper()
            lines.append(f"{role}: {turn.get('content', '')}")
        lines.append(f"USER: {user_message}")
        lines.append("ASSISTANT:")
        return "\n".join(lines)

    def _rule_based_chat(self, report: Dict[str, Any], user_message: str) -> str:
        verdict = report.get("verdict")
        action = report.get("recommendedAction") or report.get("recommended_action")
        narrative = report.get("narrative") or ""
        return (
            f"(LLM unavailable — deterministic answer) The report's verdict is "
            f"{verdict} with recommended action {action}. "
            f"Re: '{user_message}': see narrative — {narrative[:240]}"
        )

    def _rule_based_report(self, event: Dict[str, Any]) -> InvestigationReport:
        """
        Deterministic fallback. Used when the LLM cannot be invoked or
        parsed.

        Verdict resolution order:

        1. If the upstream `decision` is DECLINE, this transaction was
           blocked — the verdict must reflect that. When the source is
           a rule (PRE_RULE / POST_RULE) the raw ML probability is
           irrelevant (the rule short-circuited ML), so we report
           FRAUD_CONFIRMED with the agent's confidence pegged to a
           rule-driven baseline of 0.90.
        2. Otherwise (decision = ACCEPT) we fall back to bucketing on
           the ML score, which is the original behaviour.
        """
        prob = float(event.get("fraud_probability") or 0.0)
        amount = float(event.get("amount") or 0.0)
        txn_type = event.get("transaction_type") or "UNKNOWN"
        decision = (event.get("decision") or "").upper()
        # FIA's Kafka consumer events come straight from RDA's
        # publishTransactionEvent, which embeds decision_source in
        # newer schemas. Older payloads won't have it — treat as ML.
        source = (event.get("decision_source") or "ML").upper()
        rule_name = event.get("rule_name") or event.get("ruleName")

        if decision == "DECLINE":
            if source in ("PRE_RULE", "POST_RULE"):
                verdict = "FRAUD_CONFIRMED"
                action = "BLOCK"
                conf = 0.90
                indicators = [
                    f"Rule fired: {rule_name or 'unnamed rule'} ({source.lower()})",
                    f"Amount: NGN {amount:,.2f}",
                    f"Type: {txn_type}",
                    f"ML probability (informational): {prob:.2f}",
                ]
                narrative = (
                    f"Automated fallback report (LLM unavailable). The transaction "
                    f"was DECLINED by rule '{rule_name or 'unnamed rule'}' at the "
                    f"{source.replace('_RULE', '').lower()}-ML stage. ML probability "
                    f"was {prob:.2f} — informational only since the rule already "
                    f"resolved the decision. Recommended action: {action}. Verify "
                    f"the rule still matches current policy."
                )
            elif prob >= 0.85:
                verdict, action, conf = "FRAUD_CONFIRMED", "BLOCK", min(prob, 0.95)
                indicators = [
                    f"ML probability: {prob:.2f}",
                    f"Amount: NGN {amount:,.2f}",
                    f"Type: {txn_type}",
                ]
                narrative = (
                    f"Automated fallback report (LLM unavailable). The ML model "
                    f"flagged this {txn_type.lower()} of NGN {amount:,.2f} with high "
                    f"probability {prob:.2f}. Recommended action: {action}."
                )
            else:
                verdict, action, conf = "UNCERTAIN", "MANUAL_REVIEW", max(prob, 0.65)
                indicators = [
                    f"ML probability: {prob:.2f}",
                    f"Decision source: {source}",
                    f"Amount: NGN {amount:,.2f}",
                ]
                narrative = (
                    f"Automated fallback report (LLM unavailable). Transaction was "
                    f"DECLINED but the ML probability ({prob:.2f}) is below the "
                    f"high-confidence threshold. Manual review required."
                )
        elif prob >= 0.65:
            verdict, action, conf = "UNCERTAIN", "MANUAL_REVIEW", prob
            indicators = [
                f"ML probability: {prob:.2f}",
                f"Amount: NGN {amount:,.2f}",
                f"Type: {txn_type}",
            ]
            narrative = (
                f"Automated fallback report (LLM unavailable). The ML model flagged "
                f"this {txn_type.lower()} of NGN {amount:,.2f} with probability "
                f"{prob:.2f} — borderline. Recommended action: {action}."
            )
        else:
            verdict, action, conf = "LIKELY_LEGITIMATE", "RELEASE", max(1 - prob, 0.55)
            indicators = [
                f"ML probability: {prob:.2f}",
                f"Amount: NGN {amount:,.2f}",
                f"Type: {txn_type}",
            ]
            narrative = (
                f"Automated fallback report (LLM unavailable). Low fraud probability "
                f"({prob:.2f}) on this {txn_type.lower()} of NGN {amount:,.2f}. "
                f"Recommended action: {action}."
            )

        return InvestigationReport(
            verdict=verdict,
            agent_confidence=conf,
            recommended_action=action,
            key_indicators=indicators,
            narrative=narrative,
        )
