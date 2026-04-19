import { AxiosError } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, getHealth, validateSmiles } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nmr api", () => {
  it("does not silently fall back to mock data on network failure by default", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new AxiosError("Network Error", "ERR_NETWORK"));

    await expect(getHealth()).rejects.toThrow("Network Error");
  });

  it("passes abort signals through axios requests", async () => {
    const controller = new AbortController();
    const postSpy = vi.spyOn(api, "post").mockResolvedValue({
      data: { valid: true, canonical_smiles: "CCO" },
    });

    await validateSmiles("CCO", { signal: controller.signal });

    expect(postSpy).toHaveBeenCalledWith(
      "/validate",
      { smiles: "CCO" },
      { signal: controller.signal },
    );
  });
});
