import { Api } from "./api";
import type { Context } from "./context";
import { loadToken } from "./credentials";
import { NotSignedInError } from "./errors";

/** The API with this machine's token; "Not signed in. Run: beaver login" without one. */
export async function signedInApi(ctx: Context): Promise<Api> {
  const found = await loadToken(ctx);
  if (!found) throw new NotSignedInError();
  return new Api(ctx, found.token);
}
