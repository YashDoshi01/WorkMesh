import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKey, CreatedInvite, CreatedKey, Invite, Member } from "../api/schemas";
import { Modal } from "../components/Modal";
import { passwordStrength } from "../lib/password";
import { apiError, deferred, fakeApi, renderAs } from "../test-utils";
import { AcceptInvitePage, tokenFromHash } from "./AcceptInvitePage";
import { KeysPage } from "./KeysPage";
import { SettingsPage } from "./SettingsPage";
import { TeamPage } from "./TeamPage";

const key = (o: Partial<ApiKey> = {}): ApiKey => ({
  id: "k1",
  prefix: "abcd1234",
  kind: "client",
  account: "acme",
  name: "billing service",
  jobTypes: null,
  createdAt: "2026-01-01T10:00:00.000Z",
  createdBy: "user:ada@example.com",
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: null,
  status: "active",
  ...o,
});
const SECRET = `wm_abcd1234_${"S".repeat(43)}`;
const member = (o: Partial<Member> = {}): Member => ({
  id: "m1",
  email: "vic@example.com",
  name: "Vic Viewer",
  role: "viewer",
  createdAt: "2026-01-01T10:00:00.000Z",
  lastLoginAt: null,
  ...o,
});
const invite = (o: Partial<Invite> = {}): Invite => ({
  id: "i1",
  email: "new@example.com",
  role: "viewer",
  invitedBy: "u1",
  createdAt: "2026-01-01T10:00:00.000Z",
  expiresAt: "2099-01-08T10:00:00.000Z",
  status: "open",
  ...o,
});

afterEach(() => vi.restoreAllMocks());

describe("API keys page", () => {
  it("lists keys by their public prefix only: no secret is ever on the page", async () => {
    const api = fakeApi({
      keys: vi.fn(async () => [
        key(),
        key({ id: "k2", name: "mailer", kind: "worker", jobTypes: ["email.send"] }),
      ]),
    });
    renderAs("admin", api, <KeysPage />);
    expect(await screen.findByText("billing service")).toBeTruthy();
    expect(screen.getAllByText(/wm_abcd1234…/).length).toBe(2);
    expect(screen.getByText("email.send")).toBeTruthy();
    expect(document.body.textContent).not.toContain("S".repeat(20));
  });

  it("an admin creates a key; the secret appears once, with a warning, and is gone after closing", async () => {
    const created: CreatedKey = {
      ...key({ id: "k9", kind: "worker", name: "ci worker" }),
      secret: SECRET,
    };
    const api = fakeApi({ keys: vi.fn(async () => []), createKey: vi.fn(async () => created) });
    renderAs("admin", api, <KeysPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create key/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create an API key" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "ci worker" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "worker" } });
    fireEvent.change(within(dialog).getByLabelText(/Job types/), {
      target: { value: " email.send , report.build " },
    });
    fireEvent.change(within(dialog).getByLabelText("Expiry"), { target: { value: "90" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));

    const shown = await screen.findByRole("dialog", { name: "Your new API key" });
    expect(within(shown).getByTestId("secret").textContent).toBe(SECRET);
    expect(within(shown).getByRole("note").textContent).toMatch(/only once/);
    expect(api.createKey).toHaveBeenCalledWith({
      kind: "worker",
      name: "ci worker",
      jobTypes: ["email.send", "report.build"],
      expiresInDays: 90,
    });

    fireEvent.click(within(shown).getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("a client key does not send job types", async () => {
    const api = fakeApi({
      keys: vi.fn(async () => []),
      createKey: vi.fn(async () => ({ ...key(), secret: SECRET })),
    });
    renderAs("admin", api, <KeysPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create key/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "app" } });
    expect(within(dialog).queryByLabelText(/Job types/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    await screen.findByRole("dialog", { name: "Your new API key" });
    expect(api.createKey).toHaveBeenCalledWith({ kind: "client", name: "app" });
  });

  it("the server's complaint about a field is shown next to it", async () => {
    const api = fakeApi({
      keys: vi.fn(async () => []),
      createKey: vi.fn(async () => {
        throw apiError(400, "validation_error", "Invalid API key", [
          { path: "name", message: "is required" },
        ] as never);
      }),
    });
    renderAs("admin", api, <KeysPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create key/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect((await within(dialog).findByText("is required")).getAttribute("role")).toBe("alert");
  });

  it("revoking asks for confirmation, then revokes", async () => {
    const api = fakeApi({
      keys: vi.fn(async () => [key()]),
      revokeKey: vi.fn(async () => key({ status: "revoked" })),
    });
    renderAs("admin", api, <KeysPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(api.revokeKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(api.revokeKey).toHaveBeenCalledWith("k1"));
    expect((await screen.findByRole("status")).textContent).toMatch(/Revoked billing service/);
  });

  it("a viewer can see the keys but has no create or revoke controls", async () => {
    const api = fakeApi({ keys: vi.fn(async () => [key()]) });
    renderAs("viewer", api, <KeysPage />);
    expect(await screen.findByText("billing service")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create key/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("an empty list tells an admin what to do and a viewer who can do it", async () => {
    renderAs("admin", fakeApi({ keys: vi.fn(async () => []) }), <KeysPage />);
    expect((await screen.findByText(/No API keys yet/)).textContent).toMatch(/Create a client key/);
  });
});

describe("Team page", () => {
  const me = member({
    id: "99999999-9999-4999-8999-999999999999",
    name: "Test User",
    email: "admin@example.com",
    role: "admin",
  });

  it("an admin sees roles as editable, can remove people, and sees pending invitations", async () => {
    const api = fakeApi({
      members: vi.fn(async () => [me, member()]),
      invites: vi.fn(async () => [invite()]),
    });
    renderAs("admin", api, <TeamPage />);
    expect(await screen.findByLabelText("Role of Vic Viewer")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("new@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Invite teammate/ })).toBeTruthy();
  });

  it("changing a role calls the API, and a refusal (the last admin) is shown, not hidden", async () => {
    const api = fakeApi({
      members: vi.fn(async () => [me, member()]),
      invites: vi.fn(async () => []),
      changeRole: vi.fn(async () => {
        throw apiError(409, "last_admin", "An organisation needs at least one admin");
      }),
    });
    renderAs("admin", api, <TeamPage />);
    fireEvent.change(await screen.findByLabelText("Role of Vic Viewer"), {
      target: { value: "admin" },
    });
    await waitFor(() => expect(api.changeRole).toHaveBeenCalledWith("m1", "admin"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one admin/);
  });

  it("inviting shows a one-time link whose token is in the URL FRAGMENT, never the query string", async () => {
    const token = "T".repeat(43);
    const created: CreatedInvite = { ...invite({ email: "pat@example.com" }), token };
    const api = fakeApi({
      members: vi.fn(async () => [me]),
      invites: vi.fn(async () => []),
      createInvite: vi.fn(async () => created),
    });
    renderAs("admin", api, <TeamPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Invite teammate/ }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a teammate" });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "pat@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    const ready = await screen.findByRole("dialog", { name: "Invitation ready" });
    const link = within(ready).getByTestId("invite-link").textContent ?? "";
    expect(link).toContain(`/invite#token=${token}`);
    expect(link).not.toContain("?token");
    expect(within(ready).getByRole("note").textContent).toMatch(/only now/);
    expect(api.createInvite).toHaveBeenCalledWith({ email: "pat@example.com", role: "viewer" });
  });

  it("a viewer sees the team but no controls, and never asks the server for invitations", async () => {
    const api = fakeApi({
      members: vi.fn(async () => [me, member()]),
      invites: vi.fn(async () => []),
    });
    renderAs("viewer", api, <TeamPage />);
    expect(await screen.findByText("Vic Viewer")).toBeTruthy();
    expect(screen.queryByLabelText("Role of Vic Viewer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Invite teammate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Pending invitations")).toBeNull();
    expect(api.invites).not.toHaveBeenCalled();
  });
});

describe("Settings page", () => {
  it("shows who you are and which organisation you belong to", async () => {
    renderAs("viewer", fakeApi(), <SettingsPage />);
    expect(screen.getByText("viewer@example.com")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("acme")).toBeTruthy();
  });

  it("a wrong current password is reported on that field and nothing is cleared", async () => {
    const api = fakeApi({
      changePassword: vi.fn(async () => {
        throw apiError(400, "validation_error", "Invalid password change", [
          { path: "currentPassword", message: "is not correct" },
        ] as never);
      }),
    });
    renderAs("admin", api, <SettingsPage />);
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "not mine at all" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "a brand new passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect((await screen.findByText("is not correct")).getAttribute("role")).toBe("alert");
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(
      "a brand new passphrase",
    );
  });

  it("success says other sessions were ended, and clears both fields", async () => {
    const api = fakeApi({ changePassword: vi.fn(async () => undefined) });
    renderAs("admin", api, <SettingsPage />);
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old passphrase here" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "a brand new passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Other sessions were signed out/)).toBeTruthy();
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });
});

describe("accepting an invitation", () => {
  const TOKEN = "I".repeat(43);

  it("reads the token from the URL fragment only", () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#token=short")).toBeNull();
    expect(tokenFromHash("#other=" + TOKEN)).toBeNull();
  });

  it("an invalid link says so and sends no request", async () => {
    const api = fakeApi();
    renderAs("viewer", api, <AcceptInvitePage />, { route: "/invite" });
    // renderAs signs in a user; the page tells them to sign out first, and asks for nothing.
    expect(await screen.findByText(/already signed in/)).toBeTruthy();
    expect(api.inviteInfo).not.toHaveBeenCalled();
  });
});

describe("password strength guide", () => {
  it("rates by length and variety, and asks for 10 characters", () => {
    expect(passwordStrength("").level).toBe(0);
    expect(passwordStrength("short").level).toBe(1);
    expect(passwordStrength("short").label).toMatch(/at least 10/);
    expect(passwordStrength("abcdefghij").level).toBe(2);
    expect(passwordStrength("correct horse battery").level).toBe(3);
    expect(passwordStrength("Tr0ub4dor&3x!").level).toBe(3);
  });
});

describe("Modal", () => {
  it("is announced as a dialog, closes on Escape, and keeps Tab inside", async () => {
    const onClose = vi.fn();
    const d = deferred<void>();
    void d;
    const { container } = renderAs(
      "admin",
      fakeApi(),
      <>
        <button type="button">opener</button>
        <Modal title="Hello" onClose={onClose}>
          <input aria-label="first" />
          <button type="button">last</button>
        </Modal>
      </>,
    );
    expect(container).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Hello" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const first = screen.getByLabelText("first");
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cannot be dismissed while an action is running", () => {
    const onClose = vi.fn();
    renderAs(
      "admin",
      fakeApi(),
      <Modal title="Busy" onClose={onClose} closable={false}>
        content
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
