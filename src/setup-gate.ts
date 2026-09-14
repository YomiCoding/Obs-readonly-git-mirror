/**
 * Settings text controls report their value more than once (on change and again on blur), and the
 * input keeps showing what was pasted. A one-time setup code must not be submitted twice: the second
 * claim is refused by the server and the user sees an error right after linking succeeded.
 * Only a successfully applied code is remembered, so re-pasting after a failure still retries.
 */
export class SetupCodeGate {
  private lastApplied = "";

  shouldApply(code: string): boolean {
    return code !== "" && code !== this.lastApplied;
  }

  applied(code: string): void {
    this.lastApplied = code;
  }
}
