import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 4 }) : null;

describeDatabase("PostgreSQL invariants", () => {
  afterAll(async () => { await sql?.end(); });

  it("protects the final owner", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql!`insert into users(email,normalized_email,password_hash) values
      (${`${suffix}@example.test`},${`${suffix}@example.test`},'test') returning id`;
    const [business] = await sql!`insert into businesses(name) values ('Owner Test') returning id`;
    const [membership] = await sql!`insert into business_memberships(business_id,user_id,is_owner)
      values (${business!.id},${user!.id},true) returning id`;
    await expect(sql!`update business_memberships set is_owner=false where id=${membership!.id}`)
      .rejects.toThrow("cannot remove or disable the final business owner");
  });

  it("rejects overlapping reserved intervals but allows adjacent ones", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql!`insert into users(email,normalized_email,password_hash)
      values (${`${suffix}@example.test`},${`${suffix}@example.test`},'test') returning id`;
    const [business] = await sql!`insert into businesses(name) values ('Schedule Test') returning id`;
    const [location] = await sql!`insert into locations(business_id,name) values (${business!.id},'Salon') returning id`;
    const [employee] = await sql!`insert into employees(business_id,display_name) values (${business!.id},'Groomer') returning id`;
    const [customer] = await sql!`insert into customers(business_id,first_name,last_name)
      values (${business!.id},'Pat','Owner') returning id`;
    const [pet] = await sql!`insert into pets(business_id,customer_id,name)
      values (${business!.id},${customer!.id},'Mochi') returning id`;
    const insert = (start: string, end: string) => sql!`
      insert into appointments
        (business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,created_by,updated_by)
      values (${business!.id},${location!.id},${customer!.id},${pet!.id},${employee!.id},
        ${start},${end},${user!.id},${user!.id})
    `;
    await insert("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await insert("2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z");
    await expect(insert("2026-08-01T09:30:00Z", "2026-08-01T10:30:00Z")).rejects.toThrow();
  });

  it("enforces row-level tenant isolation for a non-owner database role", async () => {
    const [businessA] = await sql!`insert into businesses(name) values ('RLS A') returning id`;
    const [businessB] = await sql!`insert into businesses(name) values ('RLS B') returning id`;
    await sql!`
      insert into customers(business_id,first_name,last_name) values
        (${businessA!.id},'Visible','Customer'),
        (${businessB!.id},'Hidden','Customer')
    `;
    await sql!.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname='pawsh_rls_test') then
          create role pawsh_rls_test nologin nosuperuser nobypassrls;
        end if;
      end $$;
      grant usage on schema public to pawsh_rls_test;
      grant select,insert,update,delete on customers to pawsh_rls_test;
    `);
    await sql!.begin(async (tx) => {
      await tx`set local role pawsh_rls_test`;
      await tx`select set_config('app.business_id',${businessA!.id},true)`;
      const visible = await tx<{ business_id: string }[]>`select business_id from customers`;
      expect(visible).toHaveLength(1);
      expect(visible[0]?.business_id).toBe(businessA!.id);
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`
          insert into customers(business_id,first_name,last_name)
          values (${businessB!.id},'Blocked','Write')
        `;
      })).rejects.toThrow();
    });
  });
});
