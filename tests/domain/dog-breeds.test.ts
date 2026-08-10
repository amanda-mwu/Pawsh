import {describe,expect,it} from "vitest";
import {catalogBreedName,dogBreeds,normalizeBreedSearch,searchDogBreeds} from "../../src/domain/pets/dog-breeds.js";

describe("dog breed catalog",()=>{
  it("is comprehensive and has unique normalized names",()=>{
    expect(dogBreeds.length).toBeGreaterThan(200);
    const normalized=dogBreeds.map(breed=>breed.search);
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(["Golden Retriever","Mixed Breed","Unknown","Other"].every(name=>dogBreeds.some(breed=>breed.name===name))).toBe(true);
  });
  it("normalizes case, whitespace, punctuation and ranks prefix matches",()=>{
    expect(normalizeBreedSearch("  German---  Shepherd  ")).toBe("german shepherd");
    expect(searchDogBreeds("GOLD")[0]?.name).toBe("Golden Retriever");
    expect(searchDogBreeds("shorthaired").some(breed=>breed.name==="German Shorthaired Pointer")).toBe(true);
    expect(catalogBreedName("  golden   retriever ")).toBe("Golden Retriever");
  });
  it("preserves non-catalog values",()=>expect(catalogBreedName("Historic Village Dog")).toBeNull());
});
