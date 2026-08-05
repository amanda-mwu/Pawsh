import {describe,expect,it} from "vitest";
import {evaluateRabiesForAppointment} from "../../src/domain/rabies.js";

describe("appointment-date rabies validity",()=>{
  const base={verificationStatus:"staff_verified" as const,currentBusinessDate:"2032-08-01"};
  it("uses inclusive expiration semantics",()=>{
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-10"}))
      .toBe("valid_for_appointment");
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-11"}))
      .toBe("expires_before_appointment");
  });
  it("distinguishes expired, unverified, and missing records",()=>{
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-07-31",appointmentLocalDate:"2032-08-11"}))
      .toBe("expired");
    expect(evaluateRabiesForAppointment({...base,verificationStatus:"unverified",expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-11"}))
      .toBe("unverified");
    expect(evaluateRabiesForAppointment({...base,verificationStatus:"not_provided",expirationDate:null,appointmentLocalDate:"2032-08-11"}))
      .toBe("not_provided");
  });
});
