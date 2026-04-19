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
const DEMO_MODE_ENABLED = import.meta.env.VITE_NMR_ENABLE_DEMO_MODE === "1";

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { "Content-Type": "application/json" },
});

export class NmrApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "NmrApiError";
    this.status = status;
  }
}

export function isRequestCanceled(error: unknown) {
  return axios.isCancel(error) || (error instanceof AxiosError && error.code === "ERR_CANCELED");
}

function toApiError(error: unknown, fallbackMessage: string): NmrApiError {
  if (error instanceof AxiosError) {
    const detail =
      typeof error.response?.data === "object" &&
      error.response?.data &&
      "detail" in error.response.data
        ? error.response.data.detail
        : undefined;
    const message =
      typeof detail === "string"
        ? detail
        : error.response?.statusText || error.message || fallbackMessage;
    return new NmrApiError(message, error.response?.status);
  }
  if (error instanceof Error) {
    return new NmrApiError(error.message || fallbackMessage);
  }
  return new NmrApiError(fallbackMessage);
}

type RequestOptions = {
  signal?: AbortSignal;
};

async function requestWithOptionalDemo<T>(
  label: string,
  real: () => Promise<T>,
  fake: () => T,
): Promise<{ data: T; mocked: boolean }> {
  try {
    const data = await real();
    return { data, mocked: false };
  } catch (error) {
    if (isRequestCanceled(error)) {
      throw error;
    }
    if (!DEMO_MODE_ENABLED) {
      throw toApiError(error, `${label} failed`);
    }
    const ax = error as AxiosError;
    if (!ax.response) {
      console.warn(`[nmr-api] ${label} unreachable, using demo data:`, ax.message);
      return { data: fake(), mocked: true };
    }
    throw toApiError(error, `${label} failed`);
  }
}

export async function getHealth() {
  return requestWithOptionalDemo(
    "GET /health",
    async () => (await api.get<{ status: string }>("/health")).data,
    () => ({ status: "ok" }),
  );
}

export async function getOptions() {
  return requestWithOptionalDemo<OptionsResponse>(
    "GET /options",
    async () => normalizeOptionsResponse((await api.get<OptionsResponse>("/options")).data),
    () => mockOptions,
  );
}

export async function getEngines() {
  return requestWithOptionalDemo<Engine[]>(
    "GET /engines",
    async () => {
      const res = await api.get<Engine[] | { engines: Engine[] }>("/engines");
      return normalizeEnginesResponse(Array.isArray(res.data) ? res.data : res.data.engines);
    },
    () => mockEngines,
  );
}

export async function validateSmiles(smiles: string, options: RequestOptions = {}) {
  return requestWithOptionalDemo<ValidateResponse>(
    "POST /validate",
    async () =>
      (await api.post<ValidateResponse>("/validate", { smiles }, { signal: options.signal })).data,
    () => mockValidate(smiles),
  );
}

export async function predict(req: PredictRequest, options: RequestOptions = {}) {
  return requestWithOptionalDemo<PredictResponse>(
    "POST /predict",
    async () =>
      normalizePredictResponse(
        (await api.post<PredictResponse>("/predict", req, { signal: options.signal })).data,
        req,
      ),
    () => mockPredict(req),
  );
}
