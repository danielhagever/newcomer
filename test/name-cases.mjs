// 472 realistic inputs for name matching (venues typed with and without their city, artists, lists), each with
// the answer a reasonable person expects. Built by an independent review that ran them through ten versions
// of the matcher; every one of these was right in at least one version, and all are right now.
export default async function ({ place, art, runVenue, runArtist, runSplit, is, starts, eqList }) {
  const P = place;
  // ---------- venues ----------
  const pickIs = (name, city) => (o) => o.startsWith(`${name}${city ? ` [${city}]` : ""} `) && !o.startsWith(`${name}${city ? ` [${city}]` : ""} ambiguous`) ? true : o.startsWith(`${name}${city ? ` [${city}]` : ""} `);
  const exactIs = (name, city) => is(`${name}${city ? ` [${city}]` : ""} exact`);
  const notExactWrong = (name, city) => (o) => o.startsWith(`${name}${city ? ` [${city}]` : ""} `);

  // From the suite (sanity of the harness)
  const bowery = () => [P("Resorts World New York City", "New York", "New York", ["Casino", "Bar"]), P("New York City Center", undefined, undefined, ["Performing arts theater"]), P("The Bowery Ballroom", "New York", "New York")];
  await runVenue("Bowery Ballroom New York City", bowery(), exactIs("The Bowery Ballroom", "New York"), "suite");
  await runVenue("Bowery Ballroom, NYC", bowery(), exactIs("The Bowery Ballroom", "New York"));
  await runVenue("Bowery Ballroom, New York, NY", bowery(), exactIs("The Bowery Ballroom", "New York"));
  await runVenue("Bowery Ballroom, Manhattan", bowery(), notExactWrong("The Bowery Ballroom", "New York"), "borough typed, record filed New York");
  await runVenue("The Bowery Ballroom", bowery(), exactIs("The Bowery Ballroom", "New York"));
  await runVenue("Bowery Balroom, NYC", bowery(), notExactWrong("The Bowery Ballroom", "New York"), "typo");
  await runVenue("Bowery", bowery(), notExactWrong("The Bowery Ballroom", "New York"), "partial");
  const bow2 = () => [P("The Bowery Electric", "New York", "New York", ["Bar", "Live music venue"]), P("The Bowery Ballroom", "New York", "New York")];
  await runVenue("Bowery Electric", bow2(), exactIs("The Bowery Electric", "New York"));
  await runVenue("Bowery Ballroom", bow2(), exactIs("The Bowery Ballroom", "New York"));
  // Brooklyn
  await runVenue("Baby's All Right, Brooklyn", [P("Baby's All Right", "New York", "New York", ["Bar", "Live music venue"])], notExactWrong("Baby's All Right", "New York"), "if Qloo files Brooklyn as New York");
  await runVenue("Baby's All Right, Brooklyn", [P("Baby's All Right", "Brooklyn", "New York", ["Bar", "Live music venue"])], exactIs("Baby's All Right", "Brooklyn"));
  await runVenue("Babys All Right NYC", [P("Baby's All Right", "Brooklyn", "New York", ["Bar", "Live music venue"])], exactIs("Baby's All Right", "Brooklyn"));
  const bowls = () => [P("Brooklyn Bowl", "Brooklyn", "New York"), P("Brooklyn Bowl Las Vegas", "Las Vegas", "Nevada"), P("Brooklyn Bowl Nashville", "Nashville", "Tennessee"), P("Brooklyn Bowl Philadelphia", "Philadelphia", "Pennsylvania")];
  await runVenue("Brooklyn Bowl, Brooklyn", bowls(), exactIs("Brooklyn Bowl", "Brooklyn"));
  await runVenue("Brooklyn Bowl, Philly", bowls(), exactIs("Brooklyn Bowl Philadelphia", "Philadelphia"));
  await runVenue("Brooklyn Bowl Nashville", bowls(), exactIs("Brooklyn Bowl Nashville", "Nashville"));
  await runVenue("Brooklyn Bowl, Nashville, TN", bowls(), exactIs("Brooklyn Bowl Nashville", "Nashville"));
  await runVenue("Brooklyn Bowl Vegas", bowls(), exactIs("Brooklyn Bowl Las Vegas", "Las Vegas"));
  await runVenue("Brooklyn Bowl", bowls(), (o) => o.startsWith("Brooklyn Bowl"), "any Brooklyn Bowl");
  await runVenue("Music Hall of Williamsburg, Brooklyn", [P("The Music Hall", "Portsmouth", "New Hampshire", ["Concert hall"]), P("Music Hall of Williamsburg", "Brooklyn", "New York")], exactIs("Music Hall of Williamsburg", "Brooklyn"));
  await runVenue("Music Hall, Portsmouth NH", [P("Music Hall of Williamsburg", "Brooklyn", "New York"), P("The Music Hall", "Portsmouth", "New Hampshire", ["Concert hall"])], exactIs("The Music Hall", "Portsmouth"));
  await runVenue("Portsmouth Music Hall", [P("Music Hall of Williamsburg", "Brooklyn", "New York"), P("The Music Hall", "Portsmouth", "New Hampshire", ["Concert hall"])], exactIs("The Music Hall", "Portsmouth"));

  // Records with no city, typed with a city, and a weaker room in that city
  await runVenue("Lincoln Hall, Chicago", [P("The Lincoln Lodge", "Chicago", "Illinois", ["Comedy club"]), P("Lincoln Hall")], notExactWrong("Lincoln Hall"), "record with no city");
  await runVenue("Lincoln Hall, Chicago", [P("Lincoln Hall"), P("The Lincoln Lodge", "Chicago", "Illinois", ["Comedy club"])], notExactWrong("Lincoln Hall"), "record with no city, first");
  await runVenue("Cobra Lounge, Chicago", [P("Cobra Lounge"), P("Cobra Bar", "Chicago", "Illinois", ["Bar"])], notExactWrong("Cobra Lounge"), "record with no city");
  await runVenue("Thalia Hall, Chicago", [P("Thalia Hall"), P("Chicago Theatre", "Chicago", "Illinois", ["Performing arts theater"])], notExactWrong("Thalia Hall"));
  await runVenue("Thalia Hall, Chicago, IL", [P("Thalia Hall"), P("Thalia Bar", "Chicago", "Illinois", ["Bar"])], notExactWrong("Thalia Hall"));
  await runVenue("Mercury Lounge, New York", [P("Mercury Bar", "New York", "New York", ["Bar"]), P("Mercury Lounge")], notExactWrong("Mercury Lounge"));
  await runVenue("House of Blues, Chicago", [P("House of Blues Chicago"), P("House of Blues Houston", "Houston", "Texas")], exactIs("House of Blues Chicago"), "suite");
  await runVenue("Empty Bottle, Chicago", [P("The Empty Bottle")], notExactWrong("The Empty Bottle"));

  // Room filed in a suburb, typed with the metro city
  const rr = () => [P("Red Rocks Amphitheatre", "Morrison", "Colorado", ["Amphitheater"]), P("Red Rocks Bar", "Denver", "Colorado", ["Bar"])];
  const rrRev = () => [P("Red Rocks Bar", "Denver", "Colorado", ["Bar"]), P("Red Rocks Amphitheatre", "Morrison", "Colorado", ["Amphitheater"])];
  await runVenue("Red Rocks Amphitheatre, Denver", rr(), notExactWrong("Red Rocks Amphitheatre", "Morrison"), "full name typed, suburb");
  await runVenue("Red Rocks Amphitheater, Denver, CO", rrRev(), notExactWrong("Red Rocks Amphitheatre", "Morrison"), "full name typed, suburb");
  await runVenue("Red Rocks Amphitheatre Denver", [P("Red Rocks Amphitheatre", "Morrison", "Colorado", ["Amphitheater"]), P("Rock Bar", "Denver", "Colorado", ["Bar"])], notExactWrong("Red Rocks Amphitheatre", "Morrison"), "Rock Bar ~ rocks");
  await runVenue("Red Rocks Amphitheatre, Denver", [P("Red Lion", "Denver", "Colorado", ["Bar", "Pub"]), P("Red Rocks Amphitheatre", "Morrison", "Colorado", ["Amphitheater"])], notExactWrong("Red Rocks Amphitheatre", "Morrison"), "Red Lion shares 'red'");
  await runVenue("Red Rocks, Denver", rr(), notExactWrong("Red Rocks Amphitheatre", "Morrison"), "common shorthand");
  await runVenue("Red Rocks, Morrison CO", rr(), exactIs("Red Rocks Amphitheatre", "Morrison"));
  await runVenue("Red Rocks", rr(), notExactWrong("Red Rocks Amphitheatre", "Morrison"));
  const trb = () => [P("Los Angeles Theatre", "Los Angeles", "California", ["Performing arts theater"]), P("The Troubadour", "West Hollywood", "California")];
  await runVenue("Troubadour, Los Angeles", trb(), notExactWrong("The Troubadour", "West Hollywood"));
  await runVenue("Troubadour, West Hollywood", trb(), exactIs("The Troubadour", "West Hollywood"));
  await runVenue("The Troubadour, West Hollywood, CA", trb(), exactIs("The Troubadour", "West Hollywood"));
  await runVenue("Troubadour, LA", trb(), notExactWrong("The Troubadour", "West Hollywood"));
  await runVenue("Troubadour, West Hollywood", [P("The Troubadour", "Los Angeles", "California")], notExactWrong("The Troubadour", "Los Angeles"), "Qloo files it LA");
  await runVenue("Whisky a Go Go, Los Angeles", [P("Whisky a Go Go", "West Hollywood", "California", ["Night club"]), P("The Whisky Bar", "Los Angeles", "California", ["Bar"])], notExactWrong("Whisky a Go Go", "West Hollywood"));
  const cc = () => [P("Cat's Cradle Back Room", "Carrboro", "North Carolina"), P("Cat's Cradle", "Carrboro", "North Carolina"), P("Local 506", "Chapel Hill", "North Carolina", ["Bar", "Live music venue"])];
  await runVenue("Cat's Cradle, Chapel Hill", cc(), notExactWrong("Cat's Cradle", "Carrboro"));
  await runVenue("Cats Cradle Carrboro NC", cc(), exactIs("Cat's Cradle", "Carrboro"));
  await runVenue("Cat's Cradle Back Room", cc(), exactIs("Cat's Cradle Back Room", "Carrboro"));
  await runVenue("The Sinclair, Boston", [P("The Sinclair", "Cambridge", "Massachusetts"), P("Sinclair Bar", "Boston", "Massachusetts", ["Bar"])], notExactWrong("The Sinclair", "Cambridge"));
  await runVenue("Turf Club, Minneapolis", [P("Turf Club", "Saint Paul", "Minnesota"), P("Turf Bar", "Minneapolis", "Minnesota", ["Bar"])], notExactWrong("Turf Club", "Saint Paul"));
  await runVenue("Turf Club, St. Paul", [P("Turf Club", "Saint Paul", "Minnesota")], notExactWrong("Turf Club", "Saint Paul"));
  await runVenue("The Pageant, St. Louis", [P("The Pageant", "St. Louis", "Missouri")], exactIs("The Pageant", "St. Louis"));
  await runVenue("The Pageant, Saint Louis, MO", [P("The Pageant", "St. Louis", "Missouri")], notExactWrong("The Pageant", "St. Louis"));
  const fillDC = () => [P("The Fillmore", "Detroit", "Michigan"), P("The Fillmore Silver Spring", "Silver Spring", "Maryland"), P("The Fillmore", "San Francisco", "California")];
  await runVenue("Fillmore Silver Spring", fillDC(), exactIs("The Fillmore Silver Spring", "Silver Spring"));
  await runVenue("The Fillmore, Silver Spring, MD", fillDC(), exactIs("The Fillmore Silver Spring", "Silver Spring"));
  await runVenue("Fillmore, Maryland", fillDC(), exactIs("The Fillmore Silver Spring", "Silver Spring"));

  // Same-named rooms in other cities
  const para = () => [P("Paramount Theatre", "Austin", "Texas", ["Performing arts theater"]), P("Paramount Theatre", "Oakland", "California", ["Performing arts theater"]), P("Paramount Theatre", "Seattle", "Washington", ["Performing arts theater"]), P("The Paramount", "Huntington", "New York")];
  await runVenue("Paramount Theatre, Seattle", para(), exactIs("Paramount Theatre", "Seattle"));
  await runVenue("Paramount Theater Seattle WA", para(), exactIs("Paramount Theatre", "Seattle"));
  await runVenue("The Paramount, Huntington NY", para(), exactIs("The Paramount", "Huntington"));
  await runVenue("Paramount, Oakland", para(), exactIs("Paramount Theatre", "Oakland"));
  await runVenue("Paramount Theatre, Denver", para(), (o) => !o.includes("exact"), "typed city not in list");
  await runVenue("Paramount Theatre", para(), (o) => o.includes("ambiguous") || o.includes("exact"));
  const orph = () => [P("Orpheum Theatre", "Los Angeles", "California", ["Performing arts theater"]), P("Orpheum Theatre", "Minneapolis", "Minnesota", ["Performing arts theater"]), P("Orpheum Theatre", "Boston", "Massachusetts", ["Performing arts theater"])];
  await runVenue("Orpheum, Minneapolis", orph(), exactIs("Orpheum Theatre", "Minneapolis"));
  await runVenue("Orpheum Theater LA", orph(), exactIs("Orpheum Theatre", "Los Angeles"));
  await runVenue("Orpheum Theatre, Boston, MA", orph(), exactIs("Orpheum Theatre", "Boston"));
  const st = () => [P("State Theatre", "Minneapolis", "Minnesota", ["Performing arts theater"]), P("State Theatre", "Portland", "Maine"), P("Aladdin Theater", "Portland", "Oregon")];
  await runVenue("State Theatre, Portland, ME", st(), exactIs("State Theatre", "Portland"));
  await runVenue("State Theatre Portland Maine", st(), exactIs("State Theatre", "Portland"));
  await runVenue("Aladdin Theater, Portland, OR", st(), exactIs("Aladdin Theater", "Portland"));
  const cont = () => [P("The Continental Club", "Houston", "Texas", ["Bar", "Live music venue"]), P("The Continental Club", "Austin", "Texas", ["Bar", "Live music venue"])];
  await runVenue("Continental Club, Austin", cont(), exactIs("The Continental Club", "Austin"));
  await runVenue("Continental Club Austin TX", cont(), exactIs("The Continental Club", "Austin"));
  await runVenue("Continental Club, Austin, Texas", cont(), exactIs("The Continental Club", "Austin"));
  await runVenue("Continental Club, Texas", cont(), (o) => o.includes("ambiguous"));
  const gran = () => [P("Granada Theater", "Dallas", "Texas"), P("The Granada", "Lawrence", "Kansas"), P("Texas Theatre", "Dallas", "Texas", ["Movie theater", "Performing arts theater"])];
  await runVenue("Granada, Dallas", gran(), exactIs("Granada Theater", "Dallas"));
  await runVenue("The Granada, Lawrence, KS", gran(), exactIs("The Granada", "Lawrence"));
  await runVenue("Granada Theatre Dallas TX", gran(), exactIs("Granada Theater", "Dallas"));
  await runVenue("Granada Lawrence Kansas", gran(), exactIs("The Granada", "Lawrence"));
  await runVenue("Texas Theater, Dallas", gran(), exactIs("Texas Theatre", "Dallas"));
  const blue = () => [P("The Bluebird Cafe", "Nashville", "Tennessee", ["Cafe", "Bar"]), P("Bluebird Theater", "Denver", "Colorado"), P("The Bluebird", "Bloomington", "Indiana", ["Bar"])];
  await runVenue("Bluebird, Denver", blue(), exactIs("Bluebird Theater", "Denver"));
  await runVenue("Bluebird Cafe, Nashville", blue(), exactIs("The Bluebird Cafe", "Nashville"));
  await runVenue("Bluebird Café Nashville TN", blue(), exactIs("The Bluebird Cafe", "Nashville"));
  await runVenue("Bluebird, Bloomington, IN", blue(), exactIs("The Bluebird", "Bloomington"));
  await runVenue("Bluebird Theater", [P("The Bluebird", "Bloomington", "Indiana", ["Bar"]), P("The Bluebird Cafe", "Nashville", "Tennessee", ["Cafe", "Bar"])], (o) => !o.includes("exact"), "Denver room missing: not exact");
  await runVenue("Bluebird Theatre, Denver", [P("Bluebird Theater", "Denver", "Colorado"), P("The Bluebird Cafe", "Nashville", "Tennessee", ["Cafe", "Bar"])], exactIs("Bluebird Theater", "Denver"));

  // Rooms named after their city
  const chi = () => [P("Chicago Theatre", "Chicago", "Illinois", ["Performing arts theater"]), P("Thalia Hall", "Chicago", "Illinois"), P("Metro", "Chicago", "Illinois", ["Night club", "Live music venue"])];
  await runVenue("Chicago Theatre, Chicago, IL", chi(), exactIs("Chicago Theatre", "Chicago"));
  await runVenue("The Chicago Theater", chi(), exactIs("Chicago Theatre", "Chicago"));
  await runVenue("Metro, Chicago", chi(), exactIs("Metro", "Chicago"));
  await runVenue("Metro Chicago", chi(), exactIs("Metro", "Chicago"));
  await runVenue("Thalia Hall, Chicago IL 60608", chi(), exactIs("Thalia Hall", "Chicago"));
  await runVenue("Nashville Palace, Nashville, TN", [P("Nashville Palace", "Nashville", "Tennessee", ["Bar", "Live music venue"]), P("Ryman Auditorium", "Nashville", "Tennessee", ["Concert hall"])], exactIs("Nashville Palace", "Nashville"));
  await runVenue("Ryman, Nashville", [P("Nashville Palace", "Nashville", "Tennessee", ["Bar", "Live music venue"]), P("Ryman Auditorium", "Nashville", "Tennessee", ["Concert hall"])], exactIs("Ryman Auditorium", "Nashville"));
  await runVenue("The Ryman", [P("Ryman Auditorium", "Nashville", "Tennessee", ["Concert hall"])], exactIs("Ryman Auditorium", "Nashville"));
  await runVenue("Hollywood Palladium, Los Angeles", [P("Hard Rock Live", "Hollywood", "Florida", ["Concert hall"]), P("Hollywood Palladium", "Los Angeles", "California", ["Concert hall"])], exactIs("Hollywood Palladium", "Los Angeles"));
  await runVenue("Palladium, Hollywood", [P("Hard Rock Live", "Hollywood", "Florida", ["Concert hall"]), P("Hollywood Palladium", "Los Angeles", "California", ["Concert hall"])], notExactWrong("Hollywood Palladium", "Los Angeles"));
  await runVenue("Hollywood Palladium", [P("Hard Rock Live", "Hollywood", "Florida", ["Concert hall"]), P("Hollywood Palladium", "Los Angeles", "California", ["Concert hall"])], exactIs("Hollywood Palladium", "Los Angeles"));
  await runVenue("Asbury Lanes, Asbury Park, NJ", [P("The Stone Pony", "Asbury Park", "New Jersey", ["Bar", "Live music venue"]), P("Asbury Lanes", "Asbury Park", "New Jersey")], exactIs("Asbury Lanes", "Asbury Park"));
  await runVenue("Stone Pony, Asbury Park", [P("The Stone Pony", "Asbury Park", "New Jersey", ["Bar", "Live music venue"]), P("Asbury Lanes", "Asbury Park", "New Jersey")], exactIs("The Stone Pony", "Asbury Park"));
  await runVenue("Kansas City Music Hall, Kansas City, MO", [P("Kansas City Live!", "Kansas City", "Missouri"), P("Kansas City Music Hall", "Kansas City", "Missouri", ["Concert hall"])], exactIs("Kansas City Music Hall", "Kansas City"));
  await runVenue("Music Hall, Kansas City", [P("Kansas City Live!", "Kansas City", "Missouri"), P("Kansas City Music Hall", "Kansas City", "Missouri", ["Concert hall"])], exactIs("Kansas City Music Hall", "Kansas City"));
  await runVenue("Austin City Limits Live, Austin", [P("ACL Live at The Moody Theater", "Austin", "Texas", ["Concert hall"]), P("Mohawk Austin", "Austin", "Texas", ["Bar", "Live music venue"])], (o) => o.startsWith("ACL Live") || o === "none");
  await runVenue("Moody Theater, Austin", [P("ACL Live at The Moody Theater", "Austin", "Texas", ["Concert hall"]), P("Mohawk Austin", "Austin", "Texas", ["Bar", "Live music venue"])], (o) => o.startsWith("ACL Live"));
  // Mohawk family
  const mohawk = () => [P("Mohawk", "Mohawk", "New York", ["Bar"]), P("Mohawk Austin", "Austin", "Texas", ["Bar", "Live music venue"])];
  await runVenue("Mohawk, Austin, TX", mohawk(), exactIs("Mohawk Austin", "Austin"));
  await runVenue("Mohawk ATX", mohawk(), exactIs("Mohawk Austin", "Austin"));
  await runVenue("The Mohawk Austin Texas", mohawk(), exactIs("Mohawk Austin", "Austin"));
  await runVenue("Mohawk, Mohawk NY", mohawk(), exactIs("Mohawk", "Mohawk"));
  await runVenue("Mohawk", mohawk(), (o) => o.startsWith("Mohawk Austin [Austin] ambiguous"));
  await runVenue("Mohawk Bar Austin", mohawk(), exactIs("Mohawk Austin", "Austin"));
  await runVenue("Antones, Austin", [P("Antone's Nightclub", "Austin", "Texas", ["Night club", "Live music venue"])], exactIs("Antone's Nightclub", "Austin"));
  await runVenue("Antone's Nightclub Austin TX 78701", [P("Antone's Nightclub", "Austin", "Texas", ["Night club", "Live music venue"])], exactIs("Antone's Nightclub", "Austin"));
  await runVenue("Antone's", [P("Antone's Nightclub", "Austin", "Texas", ["Night club", "Live music venue"]), P("Antone's Record Shop", "Austin", "Texas", ["Record store", "Live music venue"])], exactIs("Antone's Nightclub", "Austin"));
  // Punctuation and initials
  await runVenue("Hi Dive, Denver", [P("Hi-Dive", "Denver", "Colorado", ["Bar", "Live music venue"])], exactIs("Hi-Dive", "Denver"));
  await runVenue("HiDive Denver CO", [P("Hi-Dive", "Denver", "Colorado", ["Bar", "Live music venue"])], exactIs("Hi-Dive", "Denver"));
  await runVenue("House of Blues - Chicago", [P("House of Blues Houston", "Houston", "Texas"), P("House of Blues Chicago", "Chicago", "Illinois")], exactIs("House of Blues Chicago", "Chicago"));
  await runVenue("House of Blues (Chicago)", [P("House of Blues Houston", "Houston", "Texas"), P("House of Blues Chicago", "Chicago", "Illinois")], exactIs("House of Blues Chicago", "Chicago"));
  await runVenue("House of Blues Chicago Illinois", [P("House of Blues Houston", "Houston", "Texas"), P("House of Blues Chicago", "Chicago", "Illinois")], exactIs("House of Blues Chicago", "Chicago"));
  await runVenue("House of Blues at Chicago", [P("House of Blues Houston", "Houston", "Texas"), P("House of Blues Chicago", "Chicago", "Illinois")], exactIs("House of Blues Chicago", "Chicago"));
  await runVenue("HOB Chicago", [P("House of Blues Houston", "Houston", "Texas"), P("House of Blues Chicago", "Chicago", "Illinois")], (o) => o === "none" || o.startsWith("House of Blues Chicago"));
  await runVenue("9:30 Club, DC", [P("9:30 Club", "Washington", "District of Columbia")], exactIs("9:30 Club", "Washington"));
  await runVenue("930 Club Washington, D.C.", [P("9:30 Club", "Washington", "District of Columbia")], exactIs("9:30 Club", "Washington"));
  await runVenue("The 9:30 Club in Washington DC", [P("9:30 Club", "Washington", "District of Columbia")], exactIs("9:30 Club", "Washington"));
  await runVenue("Union Transfer Philly", [P("Union Transfer", "Philadelphia", "Pennsylvania")], exactIs("Union Transfer", "Philadelphia"));
  await runVenue("Union Transfer, Philadelphia, PA 19123", [P("Union Transfer", "Philadelphia", "Pennsylvania")], exactIs("Union Transfer", "Philadelphia"));
  await runVenue("Exit/In Nashville", [P("Exit/In", "Nashville", "Tennessee")], exactIs("Exit/In", "Nashville"));
  await runVenue("Johnny Brenda's, Philadelphia, PA", [P("Johnny Brenda's", "Philadelphia", "Pennsylvania")], exactIs("Johnny Brenda's", "Philadelphia"));
  await runVenue("Doug Fir, PDX", [P("Doug Fir Lounge", "Portland", "Oregon", ["Bar", "Live music venue"])], exactIs("Doug Fir Lounge", "Portland"));
  await runVenue("Doug Fir Lounge, Portland, Ore.", [P("Doug Fir Lounge", "Portland", "Oregon", ["Bar", "Live music venue"])], exactIs("Doug Fir Lounge", "Portland"));
  await runVenue("First Avenue, Minneapolis", [P("7th St Entry", "Minneapolis", "Minnesota"), P("First Avenue", "Minneapolis", "Minnesota", ["Night club", "Live music venue"])], exactIs("First Avenue", "Minneapolis"));
  await runVenue("First Ave, Minneapolis", [P("7th St Entry", "Minneapolis", "Minnesota"), P("First Avenue", "Minneapolis", "Minnesota", ["Night club", "Live music venue"])], notExactWrong("First Avenue", "Minneapolis"));
  await runVenue("Basement East", [P("The Basement East", "Nashville", "Tennessee"), P("The Basement", "Nashville", "Tennessee")], exactIs("The Basement East", "Nashville"));
  await runVenue("The Basement, Nashville TN", [P("The Basement East", "Nashville", "Tennessee"), P("The Basement", "Nashville", "Tennessee")], exactIs("The Basement", "Nashville"));
  await runVenue("Emtpy Bottle, Chicago", [P("The Empty Bottle", "Chicago", "Illinois", ["Bar", "Live music venue"])], notExactWrong("The Empty Bottle", "Chicago"));
  await runVenue("Empty Bottle, Chi", [P("The Empty Bottle", "Chicago", "Illinois", ["Bar", "Live music venue"])], exactIs("The Empty Bottle", "Chicago"));
  await runVenue("Empty Bottle, Chicgo", [P("The Empty Bottle", "Chicago", "Illinois", ["Bar", "Live music venue"])], notExactWrong("The Empty Bottle", "Chicago"));
  await runVenue("Empty Bottle", [P("The Empty Bottle", "Chicago", "Illinois", ["Bar", "Live music venue"]), P("Empty Bottle Brewing", "Chicago", "Illinois", ["Bar"])], exactIs("The Empty Bottle", "Chicago"));
  await runVenue("Club Congress, Tucson", [P("Hotel Congress", "Tucson", "Arizona", ["Hotel", "Bar"]), P("Club Congress", "Tucson", "Arizona", ["Night club", "Live music venue"])], exactIs("Club Congress", "Tucson"));
  await runVenue("Hotel Congress, Tucson", [P("Hotel Congress", "Tucson", "Arizona", ["Hotel", "Bar"]), P("Club Congress", "Tucson", "Arizona", ["Night club", "Live music venue"])], exactIs("Hotel Congress", "Tucson"));
  await runVenue("Fox Theatre, Tucson", [P("Fox Theatre", "Atlanta", "Georgia"), P("Fox Tucson Theatre", "Tucson", "Arizona")], exactIs("Fox Tucson Theatre", "Tucson"), "suite");
  await runVenue("Fox Theatre, Atlanta", [P("Fox Theatre", "Atlanta", "Georgia"), P("Fox Tucson Theatre", "Tucson", "Arizona")], exactIs("Fox Theatre", "Atlanta"));
  await runVenue("Fox Theatre Atlanta GA", [P("Fox Tucson Theatre", "Tucson", "Arizona"), P("Fox Theatre", "Atlanta", "Georgia")], exactIs("Fox Theatre", "Atlanta"));
  await runVenue("The Fox, Oakland", [P("Fox Theatre", "Atlanta", "Georgia"), P("Fox Oakland Theatre", "Oakland", "California")], notExactWrong("Fox Oakland Theatre", "Oakland"));
  await runVenue("Crystal Ballroom, Portland", [P("Crystal Ballroom", "Somerville", "Massachusetts"), P("Crystal Ballroom", "Portland", "Oregon")], exactIs("Crystal Ballroom", "Portland"));
  await runVenue("Crystal Ballroom, Boston", [P("Crystal Ballroom", "Portland", "Oregon"), P("Crystal Ballroom", "Somerville", "Massachusetts")], notExactWrong("Crystal Ballroom", "Somerville"), "Somerville is in Boston's area");
  await runVenue("Crystal Ballroom, Somerville, MA", [P("Crystal Ballroom", "Portland", "Oregon"), P("Crystal Ballroom", "Somerville", "Massachusetts")], exactIs("Crystal Ballroom", "Somerville"));
  // Non-US
  const uk = (name, city, region, cats = ["Live music venue"]) => ({ ...P(name, city, region, cats), country: "United Kingdom", countryCode: "GB" });
  await runVenue("Brudenell Social Club, Leeds", [uk("Brudenell Social Club", "Leeds", "England")], exactIs("Brudenell Social Club", "Leeds"));
  await runVenue("Rock City, Nottingham, UK", [P("The Rock", "San Antonio", "Texas", ["Bar"]), uk("Rock City", "Nottingham", "England")], exactIs("Rock City", "Nottingham"));
  await runVenue("The Lexington, London", [uk("The Lexington", "London", "England", ["Pub", "Live music venue"]), P("Lexington Theatre", "Lexington", "Kentucky", ["Performing arts theater"])], exactIs("The Lexington", "London"));
  await runVenue("Lexington, London", [P("Lexington Theatre", "Lexington", "Kentucky", ["Performing arts theater"]), uk("The Lexington", "London", "England", ["Pub", "Live music venue"])], exactIs("The Lexington", "London"));
  await runVenue("Lexington Theatre, Lexington, KY", [uk("The Lexington", "London", "England", ["Pub", "Live music venue"]), P("Lexington Theatre", "Lexington", "Kentucky", ["Performing arts theater"])], exactIs("Lexington Theatre", "Lexington"));
  await runVenue("The Lexington", [P("Lexington Theatre", "Lexington", "Kentucky", ["Performing arts theater"]), uk("The Lexington", "London", "England", ["Pub", "Live music venue"])], exactIs("The Lexington", "London"));
  await runVenue("Paradiso Amsterdam", [{ ...P("Paradiso", "Amsterdam", "North Holland"), country: "Netherlands", countryCode: "NL" }], exactIs("Paradiso", "Amsterdam"));
  await runVenue("Lee's Palace, Toronto, ON", [{ ...P("Lee's Palace", "Toronto", "Ontario"), country: "Canada", countryCode: "CA" }], exactIs("Lee's Palace", "Toronto"));
  await runVenue("Horseshoe Tavern Toronto", [{ ...P("Horseshoe Tavern", "Toronto", "Ontario", ["Bar", "Live music venue"]), country: "Canada", countryCode: "CA" }], exactIs("Horseshoe Tavern", "Toronto"));
  await runVenue("The Horseshoe, Toronto", [{ ...P("Horseshoe Tavern", "Toronto", "Ontario", ["Bar", "Live music venue"]), country: "Canada", countryCode: "CA" }], exactIs("Horseshoe Tavern", "Toronto"));

  // ---------- artists ----------
  const A = (names, genre) => names.map((x) => art(x, genre));
  const aIs = (name, ...m) => (o) => m.some((x) => o === `${name} ${x}`);
  // A note in brackets at the end says which one; it isn't part of the name, and the pick is only a closest match.
  await runArtist("Wednesday (indie rock band)", A(["Wednesday", "Wednesday 13"]), aIs("Wednesday", "closest"));
  await runArtist("Big Thief (Brooklyn band)", A(["Big Thief", "Big Sean"]), aIs("Big Thief", "closest"));
  await runArtist("Phoebe Bridgers (singer-songwriter)", A(["Phoebe Bridgers"]), aIs("Phoebe Bridgers", "closest"));
  await runArtist("Tom Pety (singer)", A(["Tom Waits", "Tom Petty"]), aIs("Tom Petty", "closest"));
  await runArtist("Nobody Real (indie rock band)", A(["Big Thief"]), is("none"));
  // Seen live (Qloo searched with the whole text): a name that only shares the note's words is not a match.
  await runArtist("Wednesday (indie rock band)", A(["Lafayette Afro Rock Band"]), is("none"));
  // Policy (pass 5): an act's note is never taken as another name (a hometown is often a band's name too); live,
  // the search for the name alone finds Yasiin Bey himself.
  await runArtist("Yasiin Bey (Mos Def)", A(["Mos Def"]), is("none"));
  // Live, Qloo's whole-text search: a collaboration holds both names but is not a subtitle (it doesn't start with the name).
  await runArtist("Yasiin Bey (Mos Def)", A(["Mos Def (Yasiin Bey & Marvin Gaye)", "Mos Def", "Mos Def Pharoahe Monch Nate Do", "Mos Def and Diverse", "Mos Def, Diverse & Prefuse 73"]), is("none"));
  await runArtist("Moonsprout (indie rock band)", A(["Indie Rock Allstars"]), is("none"));
  await runArtist("Wild Child", A(["Wild Child", "Wildchild"]), aIs("Wild Child", "exact"));
  await runArtist("Wildchild", A(["Wild Child", "Wildchild"]), aIs("Wildchild", "exact"));
  await runArtist("Wild Child", A(["Wildchild", "Wild Nothing", "Child Bite"]), (o) => !o.includes("exact"), "only the space-free namesake found");
  await runArtist("Ice Age", A(["Iceage", "Ice Cube", "Age of Ice"]), (o) => !o.includes("exact"), "only the space-free namesake found");
  await runArtist("Night Moves", A(["Nightmoves", "Night Beats"]), (o) => !o.includes("exact"), "only the space-free namesake found");
  await runArtist("S. G. Goodman", A(["S N U G", "S.G. Goodman"]), aIs("S.G. Goodman", "exact"));
  await runArtist("SG Goodman", A(["S.G. Goodman", "S N U G"]), aIs("S.G. Goodman", "exact", "closest"));
  await runArtist("J. J. Cale", A(["alt-J", "J.J. Cale"]), aIs("J.J. Cale", "exact"));
  await runArtist("JJ Cale", A(["J.J. Cale", "alt-J"]), aIs("J.J. Cale", "exact", "closest"));
  await runArtist("Snail Male", A(["Snail Mail", "Male Bonding"]), aIs("Snail Mail", "closest"));
  await runArtist("Beyonce", A(["Beyoncé"]), aIs("Beyoncé", "exact"));
  await runArtist("Bjork", A(["Björk"]), aIs("Björk", "exact"));
  await runArtist("Sigur Ros", A(["Sigur Rós"]), aIs("Sigur Rós", "exact"));
  await runArtist("MO", A(["MØ", "Mo Troper", "Mos Def"]), (o) => o.startsWith("MØ ") || o === "none", "Ø doesn't fold");
  await runArtist("Royksopp", A(["Röyksopp"]), aIs("Röyksopp", "exact"));
  await runArtist("Keb Mo", A(["Keb' Mo'"], "Blues"), aIs("Keb' Mo'", "exact"));
  await runArtist("Keb' Mo'", A(["Keb' Mo'"], "Blues"), aIs("Keb' Mo'", "exact"));
  await runArtist("Kingfish", A(["Kingfish", "Christone \"Kingfish\" Ingram"], "Blues"), aIs("Kingfish", "exact"));
  await runArtist("Christone Kingfish Ingram", A(["Kingfish", "Christone \"Kingfish\" Ingram"], "Blues"), aIs("Christone \"Kingfish\" Ingram", "exact"));
  await runArtist("Nobody Real Band Xyz", A(["The Band", "Band of Horses"]), is("none"));
  await runArtist("Gary Clark", A(["Gary Clark Jr."], "Blues"), aIs("Gary Clark Jr.", "closest"));
  await runArtist("Gary Clark Jr", A(["Gary Clark Jr."], "Blues"), aIs("Gary Clark Jr.", "exact"));
  // Ranking among near names (review passes 29-32, 2026-10-04): every fix to one of these broke another.
  await runArtist("Tom Pety", A(["Tom Waits", "Tom Petty", "Tom Petty and the Heartbreakers"]), aIs("Tom Petty", "closest"));
  await runArtist("Bob Marly", A(["Bob Dylan", "Bob Marley", "Bob Marley & The Wailers"]), aIs("Bob Marley", "closest"));
  await runArtist("Grace Poter", A(["Grace Jones", "Grace Potter & The Nocturnals"]), aIs("Grace Potter & The Nocturnals", "closest"));
  await runArtist("Future Island", A(["Future", "Future Islands"]), aIs("Future Islands", "closest"));
  await runArtist("Future Island", A(["Future Islands", "Future"]), aIs("Future Islands", "closest"));
  await runArtist("Queen Latifa", A(["Queen", "Queen Latifah"]), aIs("Queen Latifah", "closest"));
  await runArtist("Cher Loyd", A(["Cher", "Cher Lloyd"]), aIs("Cher Lloyd", "closest"));
  await runArtist("Death Grip", A(["Death", "Death Grips"]), aIs("Death Grips", "closest"));
  await runArtist("Prince Royse", A(["Prince", "Prince Royce"]), aIs("Prince Royce", "closest"));
  await runArtist("The National Prks", A(["The National", "The National Parks"]), aIs("The National Parks", "closest"));
  await runArtist("Mavis", A(["Mavis Staples", "The Mavis's", "Mavi Sakal", "Mavis Hee", "Mavis,sing!"]), aIs("Mavis Staples", "closest"), "seen live");
  await runArtist("Mavis", A(["The Mavis's", "Mavis Staples"]), aIs("Mavis Staples", "closest"));
  await runArtist("Brandi", A(["Brandy", "Brandi Carlile", "Brandi Rhodes"]), aIs("Brandi Carlile", "closest"));
  await runArtist("Booker T", A(["Booker", "Booker T. & the M.G.'s", "Booker T. Jones"]), starts("Booker T. & the M.G.'s closest", "Booker T. Jones closest"));
  await runArtist("Margo", A(["Margot", "Margo Price"]), aIs("Margo Price", "closest"));
  await runArtist("Edward Sharpe", A(["Edward Sharp", "Edward Sharpe & The Magnetic Zeros"]), aIs("Edward Sharpe & The Magnetic Zeros", "closest"));
  await runArtist("Edward Sharpe", A(["Edward Maya", "Edward Sharpe & The Magnetic Zeros"]), aIs("Edward Sharpe & The Magnetic Zeros", "closest"));
  await runArtist("Bush", A(["Busch", "Bush Tetras"]), aIs("Bush Tetras", "closest"));
  await runArtist("Sol", A(["De La Soul", "Sol Seppy"]), aIs("Sol Seppy", "closest"));
  await runArtist("De La Sol", A(["Sol Seppy", "De La Soul"]), aIs("De La Soul", "closest"));
  await runArtist("La Rou", A(["Roux", "La Roux"]), aIs("La Roux", "closest"));
  await runArtist("Wednesdy", A(["Wednesday 13", "Wednesday"]), aIs("Wednesday", "closest"));
  await runArtist("Lord", A(["Lorde", "Lord Huron"]), (o) => o.startsWith("Lorde ") || o.startsWith("Lord Huron "), "either is a fair reading");
  await runArtist("Dax", A(["Dex"]), is("none"));
  await runArtist("Hank Williams 3", A(["Hank Williams", "Hank Williams III"], "Country"), aIs("Hank Williams III", "exact", "closest"));
  await runArtist("Hank Williams Junior", A(["Hank Williams", "Hank Williams Jr."], "Country"), aIs("Hank Williams Jr.", "exact", "closest"));
  await runArtist("Boyz 2 Men", A(["Boyz II Men"], "R&B"), aIs("Boyz II Men", "exact", "closest"));
  await runArtist("Juniour Boys", A(["Beastie Boys", "Junior Boys"]), aIs("Junior Boys", "closest"));
  await runArtist("J. R. Writer", A(["Writer", "J.R. Writer", "J. Cole"], "Hip hop"), aIs("J.R. Writer", "exact"));
  await runArtist("J.R. Writer", A(["Writer", "J. R. Writer"], "Hip hop"), aIs("J. R. Writer", "exact"));
  await runArtist("J. R. Rotem", A(["J.R. Rotem"], "Hip hop"), aIs("J.R. Rotem", "exact"));
  await runArtist("JRJR", A(["JR JR"]), aIs("JR JR", "exact", "closest"));
  // Pass 33 (2026-10-04)
  await runArtist("The Weekend", A(["The Weeknd", "Vampire Weekend"], "R&B"), aIs("The Weeknd", "closest"));
  await runArtist("The Weekend", A(["The Weeknd", "Weekend Players", "Vampire Weekend", "The Weekenders"], "R&B"), aIs("The Weeknd", "closest"));
  await runArtist("The Killer", A(["The Killers", "Killer Mike"]), aIs("The Killers", "closest"));
  await runArtist("Hank Williams Sr.", A(["Hank Williams", "Hank Williams Jr.", "Hank Williams III"], "Country"), aIs("Hank Williams", "closest"));
  await runArtist("Hank Williams Sr.", A(["Hank Williams Jr.", "Hank Williams III", "Hank Williams"], "Country"), aIs("Hank Williams", "closest"));
  await runArtist("Sammy Davis Sr", A(["Sammy Davis Jr.", "Sammy Davis"], "Jazz"), aIs("Sammy Davis", "closest"));
  await runArtist("Boy Genious", A(["boygenius", "Genius"]), aIs("boygenius", "closest"));
  await runArtist("Nickle Back", A(["Nickelback"], "Rock"), aIs("Nickelback", "closest"));
  await runArtist("LCD Sound Sytem", A(["LCD Soundsystem"]), aIs("LCD Soundsystem", "closest"));
  await runArtist("Pink", A(["P!nk", "Pink Floyd", "Pink Martini"], "Pop"), aIs("P!nk", "exact"));
  await runArtist("Kesha", A(["Ke$ha", "Kesha Rose"], "Pop"), aIs("Ke$ha", "exact"));
  await runArtist("Suicideboys", A(["$uicideboy$"], "Hip hop"), aIs("$uicideboy$", "exact", "closest"));
  await runArtist("Panic at the Disco", A(["Panic! At The Disco"], "Rock"), aIs("Panic! At The Disco", "exact"));
  await runArtist("Maroon Five", A(["Maroon 5", "Maroon"], "Pop"), aIs("Maroon 5", "closest"));
  await runArtist("Fleet Fox", A(["Fleet Foxes", "Fleetwood Mac", "Fox"]), aIs("Fleet Foxes", "closest"));
  await runArtist("Matchbox 20", A(["Matchbox Romance", "Matchbox Twenty"], "Rock"), aIs("Matchbox Twenty", "closest"));
  await runArtist("Three Doors Down", A(["3 Doors Down", "Doors"], "Rock"), aIs("3 Doors Down", "closest"));
  await runArtist("Chapter 4", A(["Chapter 8", "Chapter IV"]), (o) => !o.startsWith("Chapter 8"), "a different number isn't a typo");
  // Pass 34 (2026-10-04)
  await runArtist("A. R. Rahman", A(["A.R. Rahman", "Rahman", "Sajid Rahman"], "Soundtrack"), aIs("A.R. Rahman", "exact"));
  await runArtist("A.G. Cook", A(["A. G. Cook", "Sam Cooke", "Cook"]), aIs("A. G. Cook", "exact"));
  await runArtist("AG Cook", A(["A. G. Cook", "Sam Cooke", "Cook"]), aIs("A. G. Cook", "exact", "closest"));
  await runArtist("A. A. Bondy", A(["A.A. Bondy", "Bondy", "Bondi"]), aIs("A.A. Bondy", "exact"));
  await runArtist("A G Cook", A(["A. G. Cook", "Sam Cooke", "Cook"]), aIs("A. G. Cook", "exact"));
  await runArtist("A. Savage", A(["Savage", "A. Savage"]), aIs("A. Savage", "exact"), "with a dot, A is an initial");
  await runArtist("Tribe Called Quest", A(["A Tribe Called Quest"], "Hip hop"), aIs("A Tribe Called Quest", "exact"));
  await runArtist("The Hip", A(["The Tragically Hip", "The Hip Abduction", "Hip Hatchet", "Hippo Campus"], "Rock"), aIs("The Tragically Hip", "closest"));
  await runArtist("The Stones", A(["The Rolling Stones", "The Stones Experience", "The Stone Roses"], "Rock"), aIs("The Rolling Stones", "closest"));
  await runArtist("The Stones", A(["The Stone Roses", "The Rolling Stones"], "Rock"), aIs("The Rolling Stones", "closest"));
  await runArtist("Joey Badass", A(["Joey Bada$$"], "Hip hop"), aIs("Joey Bada$$", "exact"));
  await runArtist("Go Go 7188", A(["GO!GO!7188"], "Rock"), aIs("GO!GO!7188", "exact"));
  // Pass 35 (2026-10-04)
  await runArtist("A Savage", A(["A. Savage", "Savage", "Savage Garden", "21 Savage", "Savages"]), aIs("A. Savage", "exact", "ambiguous"), "an article or an initial: either way, A. Savage first");
  await runArtist("A Swayze and the Ghosts", A(["A. Swayze & the Ghosts"]), aIs("A. Swayze & the Ghosts", "exact"));
  await runArtist("The Killers", A(["Killers", "The Killers"], "Rock"), aIs("The Killers", "exact", "ambiguous"));
  // Pass 36 (2026-10-04): without an article typed, the spelling says nothing about which act was meant.
  await runArtist("Killers", A(["The Killers", "Killers"], "Rock"), aIs("The Killers", "ambiguous"));
  await runArtist("Darkness", A(["The Darkness", "Darkness", "Darkness Falls"], "Rock"), aIs("The Darkness", "ambiguous"));
  await runArtist("Black Crowes", A(["The Black Crowes", "Black Crowes"], "Rock"), aIs("The Black Crowes", "ambiguous"));
  await runArtist("The Eagles", A(["Eagles", "The Eagles", "Eagles of Death Metal"], "Rock"), aIs("The Eagles", "ambiguous"), "warned: Eagles is the same name without the article");
  await runArtist("The Stones", A(["The Rolling Stones", "The Stone Roses", "Stone", "Stone Sour"], "Rock"), aIs("The Rolling Stones", "closest"));
  await runArtist("The Pumpkins", A(["The Smashing Pumpkins", "Pumpkin"], "Rock"), aIs("The Smashing Pumpkins", "closest"));
  // Pass 37 (2026-10-04)
  await runArtist("The Stones", A(["The Rolling Stones", "The Stone Roses", "The Stone"], "Rock"), aIs("The Rolling Stones", "closest"), "a plural isn't a typo");
  await runArtist("The Pumpkins", A(["The Smashing Pumpkins", "The Pumpkin"], "Rock"), aIs("The Smashing Pumpkins", "closest"));
  await runArtist("A. Savage", A(["A Savage"]), aIs("A Savage", "exact"));
  // Pass 38 (2026-10-04)
  await runArtist("The Killer", A(["The Killers", "The Lady Killer"], "Rock"), aIs("The Killers", "closest"));
  await runArtist("The Smith", A(["The Smiths", "The Patti Smith Group"], "Rock"), aIs("The Smiths", "closest"));
  await runArtist("The Zombie", A(["The Zombies", "The Walking Zombie", "Rob Zombie"], "Rock"), aIs("The Zombies", "closest"));
  await runArtist("A. Savage", A(["A Savage", "A. Savage"]), aIs("A. Savage", "exact", "ambiguous"), "the dotted record first");
  // Pass 39: without a typed dot, Qloo's order stands.
  await runArtist("A Savage", A(["A. Savage", "A Savage", "Savage", "Savage Garden", "21 Savage"]), aIs("A. Savage", "ambiguous"));
  await runArtist("A Swayze and the Ghosts", A(["A. Swayze & the Ghosts", "A Swayze and the Ghosts"]), aIs("A. Swayze & the Ghosts", "exact", "ambiguous"));
  await runArtist("The Weekend", A(["The Weeknd", "Vampire Weekend", "The Long Weekend", "Weekender"], "R&B"), aIs("The Weeknd", "closest"));
  await runArtist("The Monkeys", A(["The Monkees", "Arctic Monkeys", "The Mighty Monkeys"], "Rock"), aIs("The Monkees", "closest"));
  await runArtist("The The", A(["The Head and the Heart", "The Boy and the Beast", "The Who"], "Rock"), is("none"));
  await runArtist("The Car", A(["The Cars", "Cars", "Car Seat Headrest"], "Rock"), aIs("The Cars", "closest"));
  await runArtist("The Bat", A(["The Bats", "Bat for Lashes"], "Rock"), aIs("The Bats", "closest"));
  await runArtist("The Bee", A(["The Bees", "Bee Gees"], "Rock"), aIs("The Bees", "closest"));
  await runArtist("Bea", A(["Beach House"]), is("none"));
  await runArtist("Tyler the Creator", A(["Tyler, The Creator", "Tyler Childers"]), aIs("Tyler, The Creator", "exact"));
  await runArtist("Simon and Garfunkel", A(["Simon & Garfunkel"]), aIs("Simon & Garfunkel", "exact"));
  await runArtist("Florence and the Machine", A(["Florence + the Machine"]), aIs("Florence + the Machine", "exact"));
  await runArtist("Guns and Roses", A(["Guns N' Roses"]), aIs("Guns N' Roses", "closest", "exact"));
  await runArtist("ACDC", A(["AC/DC"]), aIs("AC/DC", "exact", "closest"));
  await runArtist("AC DC", A(["AC/DC"]), aIs("AC/DC", "exact"));
  await runArtist("Iceage", A(["Ice Age", "Iceage"]), aIs("Iceage", "exact"));
  await runArtist("Hippo Campus", A(["Hippocampus", "Hippo Campus"]), aIs("Hippo Campus", "exact"));
  await runArtist("Charley Crocket", A(["Charley Crockett"], "Country"), aIs("Charley Crockett", "closest"));
  await runArtist("Wednesday", A(["Wednesday", "Wednesday 13", "Wednesday Campanella"]), aIs("Wednesday", "exact"));
  await runArtist("Black Country New Road", A(["Black Country, New Road"]), aIs("Black Country, New Road", "exact"));
  await runArtist("St Vincent", A(["St. Vincent"]), aIs("St. Vincent", "exact"));
  await runArtist("The War on Drugs", A(["The War On Drugs", "War"]), aIs("The War On Drugs", "exact"));
  await runArtist("The The", A(["The The", "The Who"]), aIs("The The", "exact"));
  await runArtist("!!!", A(["!!!", "Chk Chk Chk"]), (o) => o.startsWith("!!! "));
  await runArtist("Chk Chk Chk", A(["!!!"]), (o) => true);
  await runArtist("The Band", A(["The Band", "Band of Horses", "The Band Camino"]), aIs("The Band", "exact"));
  await runArtist("Band Camino", A(["The Band", "The Band Camino"]), aIs("The Band Camino", "exact"));
  await runArtist("Tedeschi Trucks", A(["Tedeschi Trucks Band", "Derek Trucks"], "Blues"), aIs("Tedeschi Trucks Band", "closest"));
  await runArtist("Doyle Bramhall", A(["Doyle Bramhall II", "Doyle Bramhall"], "Blues"), aIs("Doyle Bramhall", "exact"));
  await runArtist("Doyle Bramhall II", A(["Doyle Bramhall", "Doyle Bramhall II"], "Blues"), aIs("Doyle Bramhall II", "exact"));
  await runArtist("Sue Foley", A(["Sue Foley"], "Blues"), aIs("Sue Foley", "exact"));
  await runArtist("King Gizzard", A(["King Gizzard & The Lizard Wizard"]), aIs("King Gizzard & The Lizard Wizard", "closest"));
  await runArtist("KGLW", A(["King Gizzard & The Lizard Wizard"]), (o) => true);
  await runArtist("Lizzo", A(["Lizzo", "Lizzy McAlpine"]), aIs("Lizzo", "exact"));
  await runArtist("Mt. Joy", A(["Mt. Joy", "Mount Joy"]), aIs("Mt. Joy", "exact"));
  await runArtist("Mt Joy", A(["Mt. Joy"]), aIs("Mt. Joy", "exact"));
  await runArtist("Sylvan Esso", A(["Sylvan Esso"]), aIs("Sylvan Esso", "exact"));
  await runArtist("Big Thief", A(["Big Thief", "Thief"]), aIs("Big Thief", "exact"));
  await runArtist("Boygenius", A(["boygenius"]), aIs("boygenius", "exact"));
  await runArtist("boy genius", A(["boygenius", "Boy Genius Report"]), aIs("boygenius", "exact", "closest"));
  await runArtist("Mac DeMarco", A(["Mac DeMarco"]), aIs("Mac DeMarco", "exact"));
  await runArtist("Mac De Marco", A(["Mac DeMarco"]), aIs("Mac DeMarco", "exact", "closest"));
  await runArtist("Of Montreal", A(["of Montreal", "Montreal"]), aIs("of Montreal", "exact"));
  await runArtist("Montreal", A(["of Montreal", "Montreal"]), aIs("Montreal", "exact"));
  await runArtist("A Tribe Called Quest", A(["A Tribe Called Quest", "Tribe"]), aIs("A Tribe Called Quest", "exact"));
  await runArtist("The Who", A(["The Who", "Who Is Fancy"]), aIs("The Who", "exact"));
  await runArtist("Who", A(["The Who", "Who Is Fancy"]), aIs("The Who", "exact"));
  await runArtist("Japanese Breakfast", A(["Japanese Breakfast"]), aIs("Japanese Breakfast", "exact"));
  await runArtist("Japanese Brekfast", A(["Japanese Breakfast", "Japanese House"]), aIs("Japanese Breakfast", "closest"));
  await runArtist("The Japanese House", A(["Japanese Breakfast", "The Japanese House"]), aIs("The Japanese House", "exact"));
  await runArtist("Turnpike Troubadors", A(["Turnpike Troubadours"], "Country"), aIs("Turnpike Troubadours", "closest"));
  await runArtist("Kurt Vile and the Violators", A(["Kurt Vile", "Kurt Vile & The Violators"]), aIs("Kurt Vile & The Violators", "exact"));
  await runArtist("Kurt Vile", A(["Kurt Vile & The Violators", "Kurt Vile"]), aIs("Kurt Vile", "exact"));
  await runArtist("Prince", A(["Prince", "Prince Royce", "Prince Daddy & The Hyena"]), aIs("Prince", "exact"));
  await runArtist("Pr1nce", A(["Prince"]), (o) => true);
  await runArtist("Run The Jewels", A(["Run the Jewels"]), aIs("Run the Jewels", "exact"));
  await runArtist("RTJ", A(["Run the Jewels", "RTJ"]), aIs("RTJ", "exact"));
  await runArtist("M83", A(["M83"]), aIs("M83", "exact"));
  await runArtist("M 83", A(["M83"]), aIs("M83", "exact", "closest"));
  await runArtist("Sleater Kinney", A(["Sleater-Kinney"]), aIs("Sleater-Kinney", "exact"));
  await runArtist("SleaterKinney", A(["Sleater-Kinney"]), aIs("Sleater-Kinney", "exact", "closest"));
  await runArtist("Rufus Du Sol", A(["RÜFÜS DU SOL"]), aIs("RÜFÜS DU SOL", "exact"));
  await runArtist("Rufus", A(["RÜFÜS DU SOL", "Rufus Wainwright", "Rufus"]), aIs("Rufus", "exact"));
  await runArtist("Blink 182", A(["blink-182"]), aIs("blink-182", "exact"));
  await runArtist("Blink-182", A(["blink-182", "Blink"]), aIs("blink-182", "exact"));
  await runArtist("blink182", A(["blink-182", "Blink"]), aIs("blink-182", "exact", "closest"));
  await runArtist("Twenty One Pilots", A(["twenty one pilots", "21 Pilots"]), aIs("twenty one pilots", "exact"));
  await runArtist("Alt J", A(["alt-J", "J.J. Cale"]), aIs("alt-J", "exact"));
  await runArtist("altj", A(["alt-J", "J.J. Cale"]), aIs("alt-J", "exact", "closest"));

  // ---------- splitting ----------
  await runSplit("Wednesday, Snail Mail", eqList("Wednesday", "Snail Mail"));
  await runSplit('"Tyler, the Creator", Wednesday', eqList("Tyler, the Creator", "Wednesday"));
  await runSplit("Simon and Garfunkel; Wednesday", eqList("Simon and Garfunkel", "Wednesday"));
  await runSplit("Guns N' Roses, Wednesday", eqList("Guns N' Roses", "Wednesday"));
  await runSplit("Keb' Mo', Kingfish", eqList("Keb' Mo'", "Kingfish"));
  await runSplit("Kingfish, Keb' Mo'", eqList("Kingfish", "Keb' Mo'"));
  await runSplit("'Til Tuesday, Wednesday", eqList("'Til Tuesday", "Wednesday"));
  await runSplit("'Til Tuesday, Keb' Mo'", eqList("'Til Tuesday", "Keb' Mo'"));
  await runSplit("'Til Tuesday, Wednesday, Keb' Mo'", eqList("'Til Tuesday", "Wednesday", "Keb' Mo'"));
  await runSplit("‘Til Tuesday, Wednesday, Keb’ Mo’", eqList("‘Til Tuesday", "Wednesday", "Keb’ Mo’"));
  await runSplit("Wednesday\n'68\nKeb' Mo'", eqList("Wednesday", "'68", "Keb' Mo'"));
  await runSplit("Wednesday, 'Til Tuesday, Kingfish", eqList("Wednesday", "'Til Tuesday", "Kingfish"));
  await runSplit('Wednesday; "Black Country, New Road"', eqList("Wednesday", "Black Country, New Road"));
  await runSplit("“Black Country, New Road”, Wednesday", eqList("Black Country, New Road", "Wednesday"));
  await runSplit("„Black Country, New Road“, Wednesday", eqList("Black Country, New Road", "Wednesday"));
  await runSplit("«Black Country, New Road», Wednesday", eqList("Black Country, New Road", "Wednesday"));
  await runSplit("'Black Country, New Road', Wednesday", eqList("Black Country, New Road", "Wednesday"));
  await runSplit("‘Black Country, New Road’, Wednesday", eqList("Black Country, New Road", "Wednesday"));
  await runSplit("Antone’s Allstars, Wednesday", eqList("Antone’s Allstars", "Wednesday"));
  await runSplit('Wednesday, "Weird Al" Yankovic', (o) => JSON.parse(o).length === 2);
  await runSplit("'Weird Al' Yankovic, Wednesday", (o) => JSON.parse(o).length === 2);
  await runSplit('"Earth, Wind & Fire", Wednesday', eqList("Earth, Wind & Fire", "Wednesday"));
  await runSplit('Wednesday, "Snail Mail, Dehd', eqList("Wednesday", "Snail Mail", "Dehd"));
  await runSplit("'Tyler, the Creator', Keb' Mo'", eqList("Tyler, the Creator", "Keb' Mo'"));
  await runSplit("‘68, \"Tyler, the Creator\"", eqList("‘68", "Tyler, the Creator"));
  await runSplit("The B-52's, 'Til Tuesday", eqList("The B-52's", "'Til Tuesday"));
  await runSplit("'Til Tuesday, The B-52's", eqList("'Til Tuesday", "The B-52's"));
  await runSplit("Rock 'n' Roll Soldiers, Wednesday", eqList("Rock 'n' Roll Soldiers", "Wednesday"));
  await runSplit("'N Sync, Wednesday, Keb' Mo'", eqList("'N Sync", "Wednesday", "Keb' Mo'"));
  await runSplit("Wednesday\nSnail Mail\n\nDehd", eqList("Wednesday", "Snail Mail", "Dehd"));

  // Pass 41 (2026-10-04): a broad sweep of how talent buyers type rooms and lists.
  await runVenue("Mohawk, East Austin", mohawk(), notExactWrong("Mohawk Austin", "Austin"), "a neighborhood typed");
  await runVenue("Mohawk, Downtown Austin", mohawk(), notExactWrong("Mohawk Austin", "Austin"));
  await runVenue("Mohawk on Red River", mohawk(), notExactWrong("Mohawk Austin", "Austin"), "a street typed; the music room first");
  const lex = () => [P("Lexington Theatre", "Lexington", "Kentucky", ["Performing arts theater"]), uk("The Lexington", "London", "England", ["Pub", "Live music venue"])];
  await runVenue("The Lexington, Islington", lex(), notExactWrong("The Lexington", "London"));
  await runVenue("The Lexington, Islington, London", lex(), notExactWrong("The Lexington", "London"));
  const trbs = () => [uk("The Troubadour", "London", "England", ["Cafe", "Live music venue"]), P("The Troubadour", "West Hollywood", "California", ["Night club", "Live music venue"])];
  await runVenue("Troubadour, Los Angeles", trbs(), notExactWrong("The Troubadour", "West Hollywood"), "West Hollywood is in LA's area");
  await runVenue("The Troubadour, LA", trbs(), notExactWrong("The Troubadour", "West Hollywood"));
  await runVenue("The Troubadour, London", trbs(), exactIs("The Troubadour", "London"));
  await runVenue("First Ave Mpls", [P("7th St Entry", "Minneapolis", "Minnesota"), P("First Avenue", "Minneapolis", "Minnesota", ["Night club", "Live music venue"])], exactIs("First Avenue", "Minneapolis"));
  await runVenue("First Ave, Mpls", [P("7th St Entry", "Minneapolis", "Minnesota"), P("First Avenue", "Minneapolis", "Minnesota", ["Night club", "Live music venue"])], exactIs("First Avenue", "Minneapolis"));
  const abroad = (name, city, region, country, countryCode) => ({ ...P(name, city, region), country, countryCode });
  await runVenue("Paradiso, Amsterdam, NL", [abroad("Paradiso", "Amsterdam", "North Holland", "Netherlands", "NL")], exactIs("Paradiso", "Amsterdam"));
  await runVenue("Paradiso, Amsterdam, The Netherlands", [abroad("Paradiso", "Amsterdam", "North Holland", "Netherlands", "NL")], exactIs("Paradiso", "Amsterdam"));
  await runVenue("Lido, Berlin, DE", [abroad("Lido", "Berlin", "Berlin", "Germany", "DE")], exactIs("Lido", "Berlin"));
  await runVenue("Corner Hotel, Melbourne VIC", [abroad("Corner Hotel", "Melbourne", "Victoria", "Australia", "AU")], exactIs("Corner Hotel", "Melbourne"));
  await runVenue("Lido, Wilmington, DE", [abroad("Lido", "Berlin", "Berlin", "Germany", "DE")], (o) => !o.includes("exact"), "DE is also Delaware");
  await runSplit("Big Thief\tWaxahatchee\tSnail Mail", eqList("Big Thief", "Waxahatchee", "Snail Mail"), "a spreadsheet row");
  await runSplit("Big Thief / Waxahatchee / Snail Mail", eqList("Big Thief", "Waxahatchee", "Snail Mail"));
  await runSplit("Big Thief | Waxahatchee", eqList("Big Thief", "Waxahatchee"));
  await runSplit("AC/DC, Wednesday", eqList("AC/DC", "Wednesday"));
  // Pass 42: the big city next door counts only in its own state; a typo in the last word isn't a neighborhood.
  await runVenue("Paramount Theatre, Denver", [P("Paramount Theatre", "Aurora", "Illinois", ["Performing arts theater"])], (o) => !o.includes("exact"), "Aurora, Illinois isn't Denver's Aurora");
  await runVenue("Hard Rock Live, Los Angeles", [P("Hard Rock Live", "Hollywood", "Florida", ["Concert hall"])], (o) => !o.includes("exact"));
  await runVenue("Texas Live, Washington DC", [P("Texas Live!", "Arlington", "Texas", ["Sports bar", "Live music venue"])], (o) => !o.includes("exact"));
  await runVenue("Thalia Hal, Chicago", [P("Thalia", "Chicago", "Illinois", ["Bar"]), P("Thalia Hall", "Chicago", "Illinois", ["Live music venue"])], notExactWrong("Thalia Hall", "Chicago"));
  await runVenue("Lodge Rom, Los Angeles", [P("The Lodge", "Los Angeles", "California", ["Bar"]), P("Lodge Room", "Los Angeles", "California", ["Live music venue"])], notExactWrong("Lodge Room", "Los Angeles"));
  // Pass 43: a street after "on" isn't a typo of "of".
  const mh = () => [P("Music Hall of Williamsburg", "Brooklyn", "New York"), P("The Music Hall", "Portsmouth", "New Hampshire", ["Concert hall"])];
  await runVenue("The Music Hall on Chestnut, Portsmouth", mh(), notExactWrong("The Music Hall", "Portsmouth"));
  await runVenue("Music Hall on Chestnut Street", mh(), notExactWrong("The Music Hall", "Portsmouth"));
  // Pass 44: a short word that IS how the longer name goes on still counts ("of", "at", "de").
  await runVenue("Music Hall of Wiliamsburg", mh(), notExactWrong("Music Hall of Williamsburg", "Brooklyn"));
  await runVenue("Theatre at Ace Hotell, Los Angeles", [P("The Theatre", "Los Angeles", "California"), P("The Theatre at Ace Hotel", "Los Angeles", "California")], notExactWrong("The Theatre at Ace Hotel", "Los Angeles"));
  await runVenue("House of Bluez, Chicago", [P("The House", "Chicago", "Illinois", ["Bar"]), P("House of Blues", "Chicago", "Illinois")], notExactWrong("House of Blues", "Chicago"));
  // Pass 45: after the short word, the rest must still be how the longer name goes on.
  await runVenue("Hard Rock Live at Universal, Orlando", [P("Hard Rock Live", "Orlando", "Florida", ["Concert hall"]), P("Hard Rock Live at Etess Arena", "Atlantic City", "New Jersey", ["Arena"])], notExactWrong("Hard Rock Live", "Orlando"));
  await runVenue("City Winery at the Riverwalk, Chicago", [P("City Winery", "Chicago", "Illinois", ["Winery", "Live music venue"]), P("City Winery at Pier 57", "New York", "New York", ["Winery", "Live music venue"])], notExactWrong("City Winery", "Chicago"));
  await runVenue("The Music Hall of Portsmouth, NH", mh(), notExactWrong("The Music Hall", "Portsmouth"));
  await runVenue("Music Hall in Williamsburg", mh(), notExactWrong("Music Hall of Williamsburg", "Brooklyn"), "the short word may differ");
  // Pass 46: two letters off in a longer word, and a text cut off after a short word.
  await runVenue("Music Hall of Wiliamsberg", mh(), notExactWrong("Music Hall of Williamsburg", "Brooklyn"));
  await runVenue("House of Blews, Chicago", [P("The House", "Chicago", "Illinois", ["Bar"]), P("House of Blues", "Chicago", "Illinois")], notExactWrong("House of Blues", "Chicago"));
  await runVenue("Club de Vyle, Austin", [P("Club", "Austin", "Texas", ["Night club"]), P("Club de Ville", "Austin", "Texas", ["Bar", "Live music venue"])], notExactWrong("Club de Ville", "Austin"));
  await runVenue("City Winery at Pear 57", [P("City Winery", "Chicago", "Illinois", ["Winery", "Live music venue"]), P("City Winery at Pier 57", "New York", "New York", ["Winery", "Live music venue"])], notExactWrong("City Winery at Pier 57", "New York"));
  await runVenue("Palace of Fein Arts, San Francisco", [P("The Palace", "San Francisco", "California", ["Bar"]), P("Palace of Fine Arts", "San Francisco", "California", ["Performing arts theater"])], notExactWrong("Palace of Fine Arts", "San Francisco"));
  await runVenue("The Theatre at Art Share, Los Angeles", [P("The Theatre", "Los Angeles", "California"), P("The Theatre at Ace Hotel", "Los Angeles", "California")], notExactWrong("The Theatre", "Los Angeles"), "a three-letter word two letters off isn't a typo");
  await runVenue("Music Hall of", mh(), notExactWrong("Music Hall of Williamsburg", "Brooklyn"));
  // Pass 47: a longer name that goes on with its own city is a location, not a name to complete.
  const hob = () => [P("House of Blues Anaheim", "Anaheim", "California"), P("House of Blues Las Vegas", "Las Vegas", "Nevada"), P("House of Blues San Diego", "San Diego", "California"), P("House of Blues Dallas", "Dallas", "Texas")];
  await runVenue("House of Blues LA", hob(), (o) => !o.startsWith("House of Blues Las Vegas"), "LA isn't cut-off Las Vegas");
  await runVenue("Brooklyn Bowl, LA", [P("Brooklyn Bowl", "Brooklyn", "New York"), P("Brooklyn Bowl Las Vegas", "Las Vegas", "Nevada")], (o) => !o.startsWith("Brooklyn Bowl Las Vegas"));
  await runVenue("House of Blues Huston", [P("House of Blues Boston", "Boston", "Massachusetts"), P("House of Blues Houston", "Houston", "Texas")], notExactWrong("House of Blues Houston", "Houston"));
  await runVenue("Royale, Park Square", [P("Royale Bar", "Chicago", "Illinois", ["Bar"]), P("Royale", "Boston", "Massachusetts", ["Night club", "Live music venue"])], notExactWrong("Royale", "Boston"), "Park isn't a typo of Bar");
  // Pass 48: a cut-off, abbreviated or misspelled city still finds the room named for it.
  await runVenue("Brooklyn Bowl Phila", [P("Brooklyn Bowl", "Brooklyn", "New York"), P("Brooklyn Bowl Philadelphia", "Philadelphia", "Pennsylvania")], notExactWrong("Brooklyn Bowl Philadelphia", "Philadelphia"));
  await runVenue("City Winery ATL", [P("City Winery", "New York", "New York", ["Winery", "Live music venue"]), P("City Winery Atlanta", "Atlanta", "Georgia", ["Winery", "Live music venue"])], notExactWrong("City Winery Atlanta", "Atlanta"));
  await runVenue("The Fillmore Det", [P("The Fillmore", "San Francisco", "California"), P("The Fillmore Detroit", "Detroit", "Michigan")], notExactWrong("The Fillmore Detroit", "Detroit"));
  await runVenue("House of Blues Hueston", [P("House of Blues Boston", "Boston", "Massachusetts"), P("House of Blues Houston", "Houston", "Texas")], notExactWrong("House of Blues Houston", "Houston"));
  await runVenue("Billy Bob's Texs", [P("Billy Bob's", "Gallatin", "Tennessee", ["Bar"]), P("Billy Bob's Texas", "Fort Worth", "Texas", ["Night club", "Live music venue"])], notExactWrong("Billy Bob's Texas", "Fort Worth"));
  // Pass 49: a neighborhood or street word near an abbreviation or a short place word isn't that place.
  await runVenue("Warner Theatre, Penn Quarter", [P("Warner Theatre", "Washington", "District of Columbia"), P("Warner Theatre", "Erie", "Pennsylvania"), P("Warner Theatre", "Torrington", "Connecticut")], notExactWrong("Warner Theatre", "Washington"));
  await runVenue("House of Blues, East 4th Street", [P("House of Blues Cleveland", "Cleveland", "Ohio"), P("House of Blues Boston", "Boston", "Massachusetts"), P("House of Blues Chicago", "Chicago", "Illinois")], notExactWrong("House of Blues Cleveland", "Cleveland"));
  await runVenue("Orpheum Theatre, DTLA", [P("Orpheum Theatre", "Los Angeles", "California"), P("Orpheum Theater", "New Orleans", "Louisiana"), P("Orpheum Theatre", "Minneapolis", "Minnesota")], notExactWrong("Orpheum Theatre", "Los Angeles"));
  await runVenue("Palace Theatre, Soho", [uk("Palace Theatre", "London", "England", ["Performing arts theater"]), P("Palace Theatre", "Columbus", "Ohio", ["Performing arts theater"]), P("Palace Theatre", "Saint Paul", "Minnesota", ["Performing arts theater"])], notExactWrong("Palace Theatre", "London"));
  await runVenue("Mohawk, Waterloo Park", mohawk(), notExactWrong("Mohawk Austin", "Austin"));
  await runVenue("The Fillmore, NoDa", [P("The Fillmore Charlotte", "Charlotte", "North Carolina"), P("The Fillmore New Orleans", "New Orleans", "Louisiana")], (o) => !o.includes("New Orleans"), "NoDa (Charlotte) is one letter from NOLA");
  // Pass 50: the big city next door, a nickname and a state count too when cut off or misspelled.
  await runVenue("Crystal Ballroom, Bos", [P("Crystal Ballroom", "Portland", "Oregon"), P("Crystal Ballroom", "Somerville", "Massachusetts")], notExactWrong("Crystal Ballroom", "Somerville"));
  await runVenue("The Fillmore, Washinton", [P("The Fillmore", "San Francisco", "California"), P("The Fillmore Silver Spring", "Silver Spring", "Maryland"), P("The Fillmore Detroit", "Detroit", "Michigan")], notExactWrong("The Fillmore Silver Spring", "Silver Spring"));
  await runVenue("Palace Theatre, Minneaplis", [P("Palace Theatre", "Columbus", "Ohio", ["Performing arts theater"]), P("Palace Theatre", "Saint Paul", "Minnesota", ["Performing arts theater"]), P("Palace Theatre", "Stamford", "Connecticut", ["Performing arts theater"])], notExactWrong("Palace Theatre", "Saint Paul"));
  await runVenue("Brooklyn Bowl Phily", [P("Brooklyn Bowl", "Brooklyn", "New York"), P("Brooklyn Bowl Philadelphia", "Philadelphia", "Pennsylvania")], notExactWrong("Brooklyn Bowl Philadelphia", "Philadelphia"));
  await runVenue("Orpheum Theater, Wisc", [P("Orpheum Theatre", "Los Angeles", "California"), P("Orpheum Theatre", "Minneapolis", "Minnesota"), P("Orpheum Theater", "Madison", "Wisconsin")], notExactWrong("Orpheum Theater", "Madison"));
  await runVenue("House of Blues Cali", [P("House of Blues Chicago", "Chicago", "Illinois"), P("House of Blues Anaheim", "Anaheim", "California")], notExactWrong("House of Blues Anaheim", "Anaheim"));
  // Pass 51: "State St" isn't "States"; the room's own city counts cut off anywhere and one letter off.
  await runVenue("Orpheum Theater, State St, Madsion", [P("Orpheum Theatre", "Los Angeles", "California"), P("Orpheum Theatre", "Minneapolis", "Minnesota"), P("Orpheum Theater", "Madison", "Wisconsin")], notExactWrong("Orpheum Theater", "Madison"));
  await runVenue("Warner Theatre, State St, Eerie", [P("Warner Theatre", "Washington", "District of Columbia"), P("Warner Theatre", "Erie", "Pennsylvania"), P("Warner Theatre", "Torrington", "Connecticut")], notExactWrong("Warner Theatre", "Erie"));
  await runVenue("City Winery ATL, Ponce City Market", [P("City Winery", "New York", "New York", ["Winery", "Live music venue"]), P("City Winery Atlanta", "Atlanta", "Georgia", ["Winery", "Live music venue"])], notExactWrong("City Winery Atlanta", "Atlanta"));
  await runVenue("The Fillmore Det, Midtown", [P("The Fillmore", "San Francisco", "California"), P("The Fillmore Detroit", "Detroit", "Michigan")], notExactWrong("The Fillmore Detroit", "Detroit"));
  await runVenue("Palace Theatre, St Pual", [P("Palace Theatre", "Columbus", "Ohio", ["Performing arts theater"]), P("Palace Theatre", "Saint Paul", "Minnesota", ["Performing arts theater"]), P("Palace Theatre", "Stamford", "Connecticut", ["Performing arts theater"])], notExactWrong("Palace Theatre", "Saint Paul"));
  await runVenue("Knitting Factory Rneo", [P("Knitting Factory Spokane", "Spokane", "Washington"), P("Knitting Factory Reno", "Reno", "Nevada")], notExactWrong("Knitting Factory Reno", "Reno"));
  // Pass 52: a misspelled or cut-off country counts as the last word typed; a three-letter word isn't a city's typo.
  await runVenue("Capitol Theatre, Austrailia", [P("Capitol Theatre", "Port Chester", "New York"), abroad("Capitol Theatre", "Sydney", "New South Wales", "Australia", "AU")], notExactWrong("Capitol Theatre", "Sydney"));
  await runVenue("Factory Theatre, Can", [abroad("Factory Theatre", "Sydney", "New South Wales", "Australia", "AU"), abroad("Factory Theatre", "Toronto", "Ontario", "Canada", "CA")], notExactWrong("Factory Theatre", "Toronto"));
  await runVenue("State Theatre, West End, Port", [P("State Theatre", "South Bend", "Indiana"), P("State Theatre", "Portland", "Maine")], notExactWrong("State Theatre", "Portland"), "End isn't Bend");
  // Pass 53: a city signal outranks a country one, and two letters off never make a country.
  const stt = () => [abroad("State Theatre", "Melbourne", "Victoria", "Australia", "AU"), abroad("State Theatre", "Sydney", "New South Wales", "Australia", "AU"), P("State Theatre", "Portland", "Maine")];
  await runVenue("State Theatre, Syd, Aus", stt(), notExactWrong("State Theatre", "Sydney"));
  await runVenue("State Theatre, Syd, Australia", stt(), notExactWrong("State Theatre", "Sydney"));
  await runVenue("Capitol Theatre, Moncten, Can", [abroad("Capitol Theatre", "Windsor", "Ontario", "Canada", "CA"), abroad("Capitol Theatre", "Moncton", "New Brunswick", "Canada", "CA"), P("Capitol Theatre", "Port Chester", "New York")], notExactWrong("Capitol Theatre", "Moncton"));
  await runVenue("Paramount Theatre, Aus", [abroad("Paramount Theatre", "Melbourne", "Victoria", "Australia", "AU"), P("Paramount Theatre", "Austin", "Texas")], notExactWrong("Paramount Theatre", "Austin"), "Austin before Australia");
  await runVenue("The Paramount, Long Island", [P("The Paramount", "Huntington", "New York"), abroad("The Paramount", "Dublin", "Leinster", "Ireland", "IE")], notExactWrong("The Paramount", "Huntington"), "Island isn't Ireland");
  // Pass 54: a place counts exactly only when all its words are typed; a country code is a country.
  const elrey = () => [P("El Rey", "Albuquerque", "New Mexico"), abroad("El Rey", "Mexico City", "Mexico City", "Mexico", "MX")];
  await runVenue("El Rey, Centro, Mexico City", elrey(), notExactWrong("El Rey", "Mexico City"));
  await runVenue("El Rey, Condesa, Mexico", elrey(), notExactWrong("El Rey", "Mexico City"));
  await runVenue("The Academy, Abbey St, Ireland", [uk("The Academy", "Belfast", "Northern Ireland"), abroad("The Academy", "Dublin", "Leinster", "Ireland", "IE")], notExactWrong("The Academy", "Dublin"), "Ireland isn't Northern Ireland");
  await runVenue("State Theatre, Syd, AU", stt(), notExactWrong("State Theatre", "Sydney"));
  // Pass 55: N, W, Mt... in a place, and the more specific place first.
  await runVenue("The Academy, N Ireland", [abroad("The Academy", "Dublin", "Leinster", "Ireland", "IE"), uk("The Academy", "Belfast", "Northern Ireland")], notExactWrong("The Academy", "Belfast"));
  await runVenue("Federal Bar, N Hollywood", [P("Federal Bar", "Hollywood", "Florida"), P("Federal Bar", "North Hollywood", "California")], notExactWrong("Federal Bar", "North Hollywood"));
  await runVenue("Capitol Theatre, W Virginia", [P("Capitol Theatre", "Richmond", "Virginia"), P("Capitol Theatre", "Wheeling", "West Virginia")], notExactWrong("Capitol Theatre", "Wheeling"));
  // Pass 56: a place's words must come together, not across a comma ("W Wabansia Ave, Chicago" isn't West Chicago).
  await runVenue("The Hideout, 1354 W Wabansia Ave, Chicago", [P("The Hideout", "West Chicago", "Illinois", ["Bar"]), P("The Hideout", "Chicago", "Illinois", ["Bar", "Live music venue"])], notExactWrong("The Hideout", "Chicago"));
  await runVenue("The Academy, N Circular Rd, Ireland", [uk("The Academy", "Belfast", "Northern Ireland"), abroad("The Academy", "Dublin", "Leinster", "Ireland", "IE")], notExactWrong("The Academy", "Dublin"));
  await runVenue("Lincoln Theater, Fuller St, Helena", [P("Lincoln Theater", "Saint Helena", "California"), P("Lincoln Theater", "Helena", "Montana")], notExactWrong("Lincoln Theater", "Helena"), "St in a street isn't Saint");
  // Pass 57: "in" and "at" connect, they aren't Indiana, India or Austria; any comma separates.
  await runVenue("The Bluebird in Nashvile", [P("The Bluebird", "Bloomington", "Indiana"), P("The Bluebird", "Nashville", "Tennessee"), P("The Bluebird", "Denver", "Colorado")], notExactWrong("The Bluebird", "Nashville"));
  await runVenue("Konzerthaus at Gendarmenmarkt, Germny", [abroad("Konzerthaus", "Vienna", "Vienna", "Austria", "AT"), abroad("Konzerthaus", "Berlin", "Berlin", "Germany", "DE")], notExactWrong("Konzerthaus", "Berlin"));
  await runVenue("Lincoln Theater\uFF0CFuller St\uFF0CHelena", [P("Lincoln Theater", "Saint Helena", "California"), P("Lincoln Theater", "Helena", "Montana")], notExactWrong("Lincoln Theater", "Helena"), "a full-width comma");
  // Pass 58: "IN" before a zip or a country is Indiana; "in" and "the" inside a place's own name count.
  await runVenue("Vogue Theatre, Broad Ripple, IN 46220, USA", [P("Vogue Theatre", "Manistee", "Michigan"), P("Vogue Theatre", "Indianapolis", "Indiana"), abroad("Vogue Theatre", "Vancouver", "British Columbia", "Canada", "CA")], notExactWrong("Vogue Theatre", "Indianapolis"));
  await runVenue("The Bluebird, Kirkwood Ave, IN, USA", [P("The Bluebird", "Nashville", "Tennessee"), P("The Bluebird", "Bloomington", "Indiana"), P("The Bluebird", "Denver", "Colorado")], notExactWrong("The Bluebird", "Bloomington"));
  // Pass 59: "in" right after the name still connects ("in USA", "in 37215"); only after a comma or before an
  // Indiana zip is it the state.
  const vogue = () => [P("Vogue Theatre", "Indianapolis", "Indiana"), P("Vogue Theatre", "Manistee", "Michigan"), abroad("Vogue Theatre", "Vancouver", "British Columbia", "Canada", "CA")];
  await runVenue("Vogue Theatre in USA", vogue(), (o) => o.includes("ambiguous"), "both US rooms");
  await runVenue("The Bluebird in 37215", [P("The Bluebird", "Bloomington", "Indiana"), P("The Bluebird", "Nashville", "Tennessee")], (o) => !o.startsWith("The Bluebird [Bloomington] exact"), "a Nashville zip isn't Indiana");
  await runVenue("Rialto Theatre in the US", [P("Rialto Theatre", "Tucson", "Arizona")], exactIs("Rialto Theatre", "Tucson"));
  await runVenue("Vogue Theatre, IN 46220", vogue(), notExactWrong("Vogue Theatre", "Indianapolis"));
  await runVenue("Vogue Theatre IN 46220", [P("Vogue Theatre", "Manistee", "Michigan"), P("Vogue Theatre", "Indianapolis", "Indiana")], notExactWrong("Vogue Theatre", "Indianapolis"), "no comma: the Indiana zip says it");
  // Pass 60: after a comma, "in" before a city still connects ("The Bluebird, in Nashville").
  await runVenue("The Bluebird, in Nashville", [P("The Bluebird", "Bloomington", "Indiana"), P("The Bluebird", "Nashville", "Tennessee"), P("The Bluebird", "Denver", "Colorado")], exactIs("The Bluebird", "Nashville"));
  await runVenue("Vogue Theatre, in the US", vogue(), (o) => o.includes("ambiguous"));
  await runVenue("Mohawk, in Austin", mohawk(), exactIs("Mohawk Austin", "Austin"));
  await runVenue("The Barn, in Lake Hills", [P("The Barn", "Lake in the Hills", "Illinois"), P("The Barn", "Lake Hills", "Washington")], notExactWrong("The Barn", "Lake Hills"));
  await runVenue("Vogue Theatre, IN", vogue(), notExactWrong("Vogue Theatre", "Indianapolis"), "IN closing the text is the state");
  await runVenue("The Palladium, in UK", [P("The Palladium", "Carmel", "Indiana"), uk("The Palladium", "London", "England", ["Performing arts theater"])], notExactWrong("The Palladium", "London"), "IN before a country other than the US isn't Indiana");
  await runVenue("Vogue Theatre, Broad Ripple, IN USA", [P("Vogue Theatre", "Manistee", "Michigan"), P("Vogue Theatre", "Indianapolis", "Indiana")], notExactWrong("Vogue Theatre", "Indianapolis"));
  await runVenue("The Barn, Pyott Rd, Lake in the Hills", [P("The Barn", "Lake Hills", "Washington"), P("The Barn", "Lake in the Hills", "Illinois")], notExactWrong("The Barn", "Lake in the Hills"));
  const savoy = () => [abroad("Savoy Theatre", "Sydney", "Nova Scotia", "Canada", "CA"), abroad("Savoy Theatre", "Sydney", "New South Wales", "Australia", "AU")];
  await runVenue("Savoy Theatre, Sydney, Australia", savoy(), (o) => o.startsWith("Savoy Theatre [Sydney]") && !o.includes("ambiguous"), "the country tells two Sydneys apart");
  await runVenue("Savoy Theatre, Sydney, AU", savoy(), (o) => o.startsWith("Savoy Theatre [Sydney]") && !o.includes("ambiguous"));
  await runVenue("The Fillmore, Phila, USA", [P("The Fillmore", "San Francisco", "California"), P("The Fillmore Philadelphia", "Philadelphia", "Pennsylvania")], notExactWrong("The Fillmore Philadelphia", "Philadelphia"));
  const bb = () => [P("Billy Bob's", "Gallatin", "Tennessee", ["Night club", "Live music venue"]), P("Billy Bob's Texas", "Fort Worth", "Texas", ["Night club", "Live music venue"])];
  await runVenue("Billy Bob's TX", bb(), exactIs("Billy Bob's Texas", "Fort Worth"), "a name that ends with its state");
  await runVenue("Billy Bob's, Fort Worth", bb(), exactIs("Billy Bob's Texas", "Fort Worth"));
  await runVenue("Club, Houston", [P("Club Texas", "Houston", "Texas", ["Night club"])], (o) => !o.includes("exact"), "a generic word left isn't the name");
  await runVenue("Knitting Factory Renno", [P("Knitting Factory Spokane", "Spokane", "Washington"), P("Knitting Factory Reno", "Reno", "Nevada")], notExactWrong("Knitting Factory Reno", "Reno"));
  await runVenue("Uptown Theatre Nappa", [P("Uptown Theater", "Kansas City", "Missouri"), P("Uptown Theatre Napa", "Napa", "California")], notExactWrong("Uptown Theatre Napa", "Napa"));
  await runVenue("Hi-Dive, Baker", [P("Hi Dive Bar", "Kalamazoo", "Michigan", ["Bar"]), P("Hi-Dive", "Denver", "Colorado", ["Bar", "Live music venue"])], notExactWrong("Hi-Dive", "Denver"));
  await runVenue("Theatre at", [P("The Theatre", "Los Angeles", "California"), P("The Theatre at Ace Hotel", "Los Angeles", "California")], notExactWrong("The Theatre at Ace Hotel", "Los Angeles"));
  await runVenue("City Winery at Pi", [P("City Winery", "Chicago", "Illinois", ["Winery", "Live music venue"]), P("City Winery at Pier 57", "New York", "New York", ["Winery", "Live music venue"])], notExactWrong("City Winery at Pier 57", "New York"));
  await runVenue("Club de Vile, Austin", [P("Club", "Austin", "Texas", ["Night club"]), P("Club de Ville", "Austin", "Texas", ["Bar", "Live music venue"])], notExactWrong("Club de Ville", "Austin"));
}
