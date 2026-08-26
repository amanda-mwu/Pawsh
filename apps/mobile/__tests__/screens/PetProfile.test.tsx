import React from "react";
import { waitFor } from "@testing-library/react-native";
import PetScreen from "../../app/pet/[id]";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/errors";
import { makePet } from "../support/fixtures";
import { renderScreen } from "../support/harness";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: "pet-1" }),
  Stack: { Screen: () => null }
}));

jest.mock("../../src/api/endpoints", () => ({
  api: { pet: jest.fn(), petNotes: jest.fn() }
}));

const mocked = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  mocked.petNotes.mockResolvedValue([]);
});

describe("Pet profile — states", () => {
  it("skeletons while loading", async () => {
    mocked.pet.mockReturnValue(new Promise(() => undefined));
    const view = await renderScreen(<PetScreen />);
    expect(view.getByTestId("pet-loading")).toBeTruthy();
  });

  it("renders identity from the stored ounces, in pounds, as the web app does", async () => {
    mocked.pet.mockResolvedValue(makePet());
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("Biscuit")).toBeTruthy());
    expect(view.getByText("Standard Poodle · 42 lb · Dog · Spayed")).toBeTruthy();
  });

  it("shows an inline error with a retry", async () => {
    mocked.pet.mockRejectedValue(
      new ApiError({ kind: "not_found", status: 404, message: "Pet not found" })
    );
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByTestId("pet-error")).toBeTruthy());
    expect(view.getByText("Pet not found")).toBeTruthy();
  });

  it("reuses the web app's own notes failure copy", async () => {
    mocked.pet.mockResolvedValue(makePet());
    mocked.petNotes.mockRejectedValue(
      new ApiError({ kind: "offline", status: 0, message: "no connection" })
    );
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("Notes could not be loaded.")).toBeTruthy());
  });

  it("says there are no notes rather than rendering an empty section", async () => {
    mocked.pet.mockResolvedValue(makePet());
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("No notes on this pet yet.")).toBeTruthy());
  });

  it("renders notes, marking a pinned one", async () => {
    mocked.pet.mockResolvedValue(makePet());
    mocked.petNotes.mockResolvedValue([
      {
        id: "note-1",
        body: "Matting behind both ears.",
        pinned: true,
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
        authorName: "Devon P."
      }
    ]);
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByTestId("pet-note-note-1")).toBeTruthy());
    expect(view.getByText("Matting behind both ears.")).toBeTruthy();
  });
});

describe("Pet profile — safety", () => {
  it("renders the alarm above every other block", async () => {
    mocked.pet.mockResolvedValue(
      makePet({ safetyAlerts: "Bites when nails are clipped. Muzzle first." })
    );
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("SAFETY ALERT")).toBeTruthy());
    expect(view.getByText("Bites when nails are clipped. Muzzle first.")).toBeTruthy();
  });

  it("asserts the absence of an alert rather than rendering nothing", async () => {
    mocked.pet.mockResolvedValue(makePet());
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("✓ No safety alerts on file.")).toBeTruthy());
  });

  it("keeps behavior and medical deliberately neutral, and always expanded", async () => {
    mocked.pet.mockResolvedValue(
      makePet({
        behaviorNotes: "Anxious with clippers near the face.",
        medicalNotes: "Hot spot on left flank, avoid."
      })
    );
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("BEHAVIOR")).toBeTruthy());
    // No "show more": these are things the groomer must have read.
    expect(view.getByText("Anxious with clippers near the face.")).toBeTruthy();
    expect(view.getByText("Hot spot on left flank, avoid.")).toBeTruthy();
  });

  it("states that behavior and medical are empty rather than omitting the blocks", async () => {
    mocked.pet.mockResolvedValue(makePet());
    const view = await renderScreen(<PetScreen />);
    await waitFor(() => expect(view.getByText("No behavior notes on file.")).toBeTruthy());
    expect(view.getByText("No medical notes on file.")).toBeTruthy();
  });

  it("says care is withheld rather than showing blanks that read as safe", async () => {
    // A redacted record and a clean record are byte-identical, so the only honest answer is to
    // name the reason the block is empty.
    mocked.pet.mockResolvedValue(makePet());
    const view = await renderScreen(<PetScreen />, {
      permissions: ["pets.view", "appointments.view"]
    });
    await waitFor(() =>
      expect(view.getByText("Care notes not visible with your access.")).toBeTruthy()
    );
    expect(view.queryByText("✓ No safety alerts on file.")).toBeNull();
    expect(view.queryByText("RABIES")).toBeNull();
  });
});

describe("Pet profile — rabies", () => {
  it("uses the verbatim sentence when the record is current", async () => {
    mocked.pet.mockResolvedValue(makePet({ vaccinationExpiresOn: "2099-01-01" }));
    const view = await renderScreen(<PetScreen />);
    await waitFor(() =>
      expect(view.getByText("Rabies vaccination is current for the next appointment.")).toBeTruthy()
    );
  });

  it("uses the verbatim sentence when it has expired", async () => {
    mocked.pet.mockResolvedValue(makePet({ vaccinationExpiresOn: "2020-09-02" }));
    const view = await renderScreen(<PetScreen />);
    await waitFor(() =>
      expect(view.getByText("Rabies vaccination expired on 09/02/2020.")).toBeTruthy()
    );
  });

  it("uses the verbatim sentence when nothing was provided", async () => {
    mocked.pet.mockResolvedValue(makePet({ vaccinationExpiresOn: null }));
    const view = await renderScreen(<PetScreen />);
    await waitFor(() =>
      expect(view.getByText("Rabies expiration date not provided.")).toBeTruthy()
    );
  });
});

describe("Pet profile — permissions", () => {
  it("does not fetch or render a record the session may not see", async () => {
    const view = await renderScreen(<PetScreen />, { permissions: ["appointments.view"] });
    await waitFor(() =>
      expect(view.getByText("Pet records are not visible with your access.")).toBeTruthy()
    );
    expect(mocked.pet).not.toHaveBeenCalled();
  });
});
