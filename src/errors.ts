/** An error meant for the person: printed as is (no stack), with an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** The server said who we are is no longer valid (token revoked / expired / missing). */
export class NotSignedInError extends CliError {
  constructor(message = "Not signed in. Run: beaver login") {
    super(message, 1);
  }
}
