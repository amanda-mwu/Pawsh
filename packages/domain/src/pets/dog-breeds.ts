export interface DogBreed { id: string; name: string; search: string }

export function normalizeBreedSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_]+/g, " ").replace(/[^a-z0-9 ]/g, "");
}

const names = [
  "Affenpinscher","Afghan Hound","Airedale Terrier","Akita","Alaskan Malamute",
  "American Bulldog","American English Coonhound","American Eskimo Dog","American Foxhound",
  "American Hairless Terrier","American Leopard Hound","American Staffordshire Terrier",
  "American Water Spaniel","Anatolian Shepherd Dog","Appenzeller Sennenhund","Australian Cattle Dog",
  "Australian Kelpie","Australian Shepherd","Australian Terrier","Azawakh","Barbet","Basenji",
  "Basset Hound","Beagle","Bearded Collie","Beauceron","Bedlington Terrier","Belgian Laekenois",
  "Belgian Malinois","Belgian Sheepdog","Belgian Tervuren","Bergamasco Sheepdog","Berger Picard",
  "Bernese Mountain Dog","Bichon Frise","Biewer Terrier","Black and Tan Coonhound",
  "Black Russian Terrier","Bloodhound","Bluetick Coonhound","Boerboel","Bohemian Shepherd",
  "Bolognese","Border Collie","Border Terrier","Borzoi","Boston Terrier","Bouvier des Flandres",
  "Boxer","Boykin Spaniel","Bracco Italiano","Braque du Bourbonnais","Briard","Brittany",
  "Brussels Griffon","Bull Terrier","Bulldog","Bullmastiff","Cairn Terrier","Canaan Dog",
  "Cane Corso","Cardigan Welsh Corgi","Carolina Dog","Catahoula Leopard Dog","Caucasian Shepherd Dog",
  "Cavalier King Charles Spaniel","Central Asian Shepherd Dog","Cesky Terrier","Chesapeake Bay Retriever",
  "Chihuahua","Chinese Crested","Chinese Shar-Pei","Chinook","Chow Chow","Clumber Spaniel",
  "Cocker Spaniel","Collie","Coton de Tulear","Curly-Coated Retriever","Dachshund","Dalmatian",
  "Dandie Dinmont Terrier","Danish-Swedish Farmdog","Doberman Pinscher","Dogo Argentino",
  "Dogue de Bordeaux","Dutch Shepherd","English Cocker Spaniel","English Foxhound","English Setter",
  "English Springer Spaniel","English Toy Spaniel","Entlebucher Mountain Dog","Estrela Mountain Dog",
  "Eurasier","Field Spaniel","Finnish Lapphund","Finnish Spitz","Flat-Coated Retriever",
  "French Bulldog","German Pinscher","German Shepherd Dog","German Shorthaired Pointer",
  "German Spitz","German Wirehaired Pointer","Giant Schnauzer","Glen of Imaal Terrier",
  "Golden Retriever","Gordon Setter","Great Dane","Great Pyrenees","Greater Swiss Mountain Dog",
  "Greyhound","Harrier","Havanese","Ibizan Hound","Icelandic Sheepdog","Irish Red and White Setter",
  "Irish Setter","Irish Terrier","Irish Water Spaniel","Irish Wolfhound","Italian Greyhound",
  "Japanese Chin","Japanese Spitz","Keeshond","Kerry Blue Terrier","Komondor","Korean Jindo Dog",
  "Kuvasz","Labrador Retriever","Lagotto Romagnolo","Lakeland Terrier","Lancashire Heeler",
  "Leonberger","Lhasa Apso","Lowchen","Maltese","Manchester Terrier","Mastiff",
  "Miniature American Shepherd","Miniature Bull Terrier","Miniature Pinscher","Miniature Schnauzer",
  "Mountain Cur","Neapolitan Mastiff","Nederlandse Kooikerhondje","Newfoundland","Norfolk Terrier",
  "Norwegian Buhund","Norwegian Elkhound","Norwegian Lundehund","Norwich Terrier",
  "Nova Scotia Duck Tolling Retriever","Old English Sheepdog","Otterhound","Papillon",
  "Parson Russell Terrier","Pekingese","Pembroke Welsh Corgi","Peruvian Inca Orchid",
  "Petit Basset Griffon Vendeen","Pharaoh Hound","Plott Hound","Pointer","Polish Lowland Sheepdog",
  "Pomeranian","Poodle","Portuguese Podengo Pequeno","Portuguese Pointer","Portuguese Water Dog",
  "Presa Canario","Pug","Puli","Pumi","Pyrenean Mastiff","Pyrenean Shepherd","Rat Terrier",
  "Redbone Coonhound","Rhodesian Ridgeback","Rottweiler","Russell Terrier","Russian Toy",
  "Saint Bernard","Saluki","Samoyed","Schipperke","Scottish Deerhound","Scottish Terrier",
  "Sealyham Terrier","Shetland Sheepdog","Shiba Inu","Shih Tzu","Siberian Husky","Silky Terrier",
  "Skye Terrier","Sloughi","Small Munsterlander","Soft Coated Wheaten Terrier","Spanish Mastiff",
  "Spinone Italiano","Staffordshire Bull Terrier","Standard Schnauzer","Sussex Spaniel",
  "Swedish Vallhund","Thai Ridgeback","Tibetan Mastiff","Tibetan Spaniel","Tibetan Terrier",
  "Toy Fox Terrier","Treeing Walker Coonhound","Vizsla","Weimaraner","Welsh Springer Spaniel",
  "Welsh Terrier","West Highland White Terrier","Whippet","Wire Fox Terrier","Wirehaired Pointing Griffon",
  "Wirehaired Vizsla","Xoloitzcuintli","Yorkshire Terrier","Cockapoo","Goldendoodle","Labradoodle",
  "Maltipoo","Pomsky","Schnoodle","Aussiedoodle","Bernedoodle","Bichonpoo","Cavapoo",
  "French Water Dog","Irish Doodle","Irish Water Dog","Lagotto","Newfoundland Dog","Newfypoo",
  "Pomapoo","Sheep Dog","Sheepadoodle","Spanish Water Dog","Wheaten Terrier","Whoodle",
  "Mixed Breed","Unknown","Other"
] as const;

export const dogBreeds: readonly DogBreed[] = names.map((name) => ({
  id: normalizeBreedSearch(name).replace(/ /g, "-"), name, search: normalizeBreedSearch(name)
}));

export function searchDogBreeds(query: string, limit = 12): readonly DogBreed[] {
  const normalized = normalizeBreedSearch(query);
  if (!normalized) return [];
  return dogBreeds.filter((breed) => breed.search.includes(normalized)).sort((a, b) => {
    const rank = Number(!a.search.startsWith(normalized)) - Number(!b.search.startsWith(normalized));
    return rank || a.name.localeCompare(b.name);
  }).slice(0, limit);
}

export function catalogBreedName(value: string): string | null {
  const normalized = normalizeBreedSearch(value);
  return dogBreeds.find((breed) => breed.search === normalized)?.name ?? null;
}
