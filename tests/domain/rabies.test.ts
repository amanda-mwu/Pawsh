import {describe,expect,it} from "vitest";
import {evaluateRabiesForAppointment,evaluateRabiesProfile} from "@pawsh/domain";

describe("appointment-date rabies validity",()=>{
  const base={verificationStatus:"staff_verified" as const,currentBusinessDate:"2032-08-01"};
  it("uses inclusive expiration semantics",()=>{
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-10"}))
      .toBe("valid_for_appointment");
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-11"}))
      .toBe("expires_before_appointment");
  });
  it("derives current-date states from expiration only",()=>{
    expect(evaluateRabiesProfile(null,"2032-08-01")).toBe("not_provided");
    expect(evaluateRabiesProfile("2032-07-31","2032-08-01")).toBe("expired");
    expect(evaluateRabiesProfile("2032-08-01","2032-08-01")).toBe("current");
  });
  it("ignores legacy verification metadata",()=>{
    expect(evaluateRabiesForAppointment({...base,expirationDate:"2032-07-31",appointmentLocalDate:"2032-08-11"}))
      .toBe("expires_before_appointment");
    expect(evaluateRabiesForAppointment({...base,verificationStatus:"unverified",expirationDate:"2032-08-10",appointmentLocalDate:"2032-08-11"}))
      .toBe("expires_before_appointment");
    expect(evaluateRabiesForAppointment({...base,verificationStatus:"not_provided",expirationDate:"2032-08-12",appointmentLocalDate:"2032-08-11"}))
      .toBe("valid_for_appointment");
    expect(evaluateRabiesForAppointment({...base,verificationStatus:"not_provided",expirationDate:null,appointmentLocalDate:"2032-08-11"}))
      .toBe("not_provided");
  });
});
