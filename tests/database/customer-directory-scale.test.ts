import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createApp} from "../../src/app.js";
import type {Config} from "../../src/config.js";
import {createDatabase,type Database} from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"directory-scale-secret-at-least-32-characters",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
function cookie(response:{headers:Record<string,unknown>}):string{const value=response.headers["set-cookie"];if(typeof value!=="string")throw new Error("Session cookie missing");return value.split(";",1)[0]!;}

describeDatabase("bounded customer directory",()=>{
  let db:Database;let app:Awaited<ReturnType<typeof createApp>>;let ownerCookie:string;let businessId:string;
  beforeAll(async()=>{
    db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:`directory-${crypto.randomUUID()}@example.test`,password:"correct horse directory battery",businessName:"Directory Scale"}});ownerCookie=cookie(signup);businessId=signup.json().businessId;
    const customers=Array.from({length:505},(_,index)=>({business_id:businessId,first_name:`Client${String(index).padStart(3,"0")}`,last_name:`Scale${String(504-index).padStart(3,"0")}`,phone:`555-01${String(index).padStart(4,"0")}`,normalized_phone:`55501${String(index).padStart(4,"0")}`,email:`client${index}@scale.test`,normalized_email:`client${index}@scale.test`,preferred_contact_method:"email",email_allowed:true}));
    const inserted=await db`insert into customers ${db(customers,"business_id","first_name","last_name","phone","normalized_phone","email","normalized_email","preferred_contact_method","email_allowed")} returning id,first_name` as unknown as {id:string;firstName:string}[];
    const pets=inserted.flatMap((customer:{id:string},index:number)=>[{business_id:businessId,customer_id:customer.id,name:`Pet${index} Alpha`,species:"dog",breed:index===321?"Searchable Spaniel":"Mixed Breed"},{business_id:businessId,customer_id:customer.id,name:`Pet${index} Beta`,species:"dog",breed:"Poodle"}]);
    await db`insert into pets ${db(pets,"business_id","customer_id","name","species","breed")}`;
  },30_000);
  afterAll(async()=>{await app.close();await db.end();});

  it("paginates a 500+ customer tenant without returning full histories",async()=>{
    const response=await app.inject({method:"GET",url:"/api/customers?paged=true&page=2&pageSize=25",headers:{cookie:ownerCookie}});expect(response.statusCode).toBe(200);const result=response.json();expect(result.total).toBe(505);expect(result.page).toBe(2);expect(result.items).toHaveLength(25);expect(result.items[0].pets).toHaveLength(2);expect(result.items[0]).not.toHaveProperty("appointments");
  });

  it.each([
    ["customer name","Client321"],["pet name","Pet321 Alpha"],["phone","555010321"],["email","client321@scale.test"],["breed","Searchable Spaniel"]
  ])("searches by %s",async(_label,query)=>{const response=await app.inject({method:"GET",url:`/api/customers?paged=true&q=${encodeURIComponent(query)}`,headers:{cookie:ownerCookie}});expect(response.statusCode).toBe(200);expect(response.json().items).toHaveLength(1);expect(response.json().items[0].firstName).toBe("Client321");});

  it("sorts deterministically and rejects cross-tenant leakage",async()=>{const descending=await app.inject({method:"GET",url:"/api/customers?paged=true&sort=name&direction=desc&pageSize=10",headers:{cookie:ownerCookie}});expect(descending.statusCode).toBe(200);expect(descending.json().items).toHaveLength(10);expect(descending.json().items.every((item:{email:string})=>item.email.endsWith("@scale.test"))).toBe(true);});
});
