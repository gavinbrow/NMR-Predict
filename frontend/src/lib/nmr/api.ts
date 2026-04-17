import axios, { AxiosError } from "axios";
import type {
  Engine,
  OptionsResponse,
  PredictRequest,
  PredictResponse,
  ValidateResponse,
} from "@/types/nmr";
import { mockEngines, mockOptions, mockPredict, mockValidate } from "./mock";
import {
  normalizeEnginesResponse,
  normalizeOptionsResponse,
  normalizePredictResponse,
} from "./normalize";

const BASE_URL = (
  (import.meta.env.VITE_NMR_API_URL as string | undefined) ?? "/api"
).replace(/\/+$/, "");

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { "Content-Type": "application/json" },
});

/** Wrap a request so a network/CORS failure transparently falls back to mock data. */
async function withFallback<T>(label: string, real: () => Promise<T>, fake: () => T): Promise<{ data: T; mocked: boolean }> {
  try {
    const data = await real();
    return { data, mocked: false };
  } catch (err) {
    const ax = err as AxiosError;
    // Only fall back on network-style errors, not on 4xx/5xx from a live backend.
    if (!ax.response) {
      // eslint-disable-next-line no-console
      console.warn(`[nmr-api] ${label} unreachable, using mock data:`, ax.message);
      return { data: fake(), mocked: true };
    }
    throw err;
  }
}

export async function getHealth() {
  return withFallback(
    "GET /health",
    async () => (await api.get<{ status: string }>("/health")).data,
    () => ({ status: "ok" }),
  );
}

export async function getOptions() {
  return withFallback<OptionsResponse>(
    "GET /options",
    async () => normalizeOptionsResponse((await api.get<OptionsResponse>("/options")).data),
    () => mockOptions,
  );
}

export async function getEngines() {
  return withFallback<Engine[]>(
    "GET /engines",
    async () => {
      const res = await api.get<Engine[] | { engines: Engine[] }>("/engines");
      return normalizeEnginesResponse(Array.isArray(res.data) ? res.data : res.data.engines);
    },
    () => mockEngines,
  );
}

export async function validateSmiles(smiles: string) {
  return withFallback<ValidateResponse>(
    "POST /validate",
    async () => (await api.post<ValidateResponse>("/validate", { smiles })).data,
    () => mockValidate(smiles),
  );
}

export async function predict(req: PredictRequest) {
  return withFallback<PredictResponse>(
    "POST /predict",
    async () => normalizePredictResponse((await api.post<PredictResponse>("/predict", req)).data, req),
    () => mockPredict(req),
  );
}
