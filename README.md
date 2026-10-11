# Menu & Grocery Planner

I made this to help me and my husband with grocery planning. My idea was to reduce food waste considering that most quantities sold in supermarkets are incompatible for a family of 2. Moreover, I always have trouble deciding what to eat.
(And I wanted a small project to learn javascript)

## Run Locally

From the project directory, start a static web server:

```powershell
python -m http.server 8765
```

Then open <http://localhost:8765/> in a browser. The app loads its TSV data with `fetch`, so it should be served over HTTP rather than opened directly as a file.

## Current Features

- Generate meal plans by days, weeks, people, meal type, and season.
- Keep selected dishes in place, or mark dishes as wanted or excluded.
- Track fridge ingredients and use package sizes to estimate shopping quantities and leftovers.
- View recipes, instructions, grocery lists, pantry checks, and ingredient metadata.
- Save planner state in the current browser using `localStorage`.
- Edit ingredient metadata in the supermarket table and download the updated TSV.

The app is local-first: browser data is not synced across devices. Ingredient edits can be downloaded, but the rest of the planner state currently has no built-in export or import. Quantity estimates depend on the units and package metadata in the TSV files; review unusual or incompatible measurements before shopping.

## Data Files

- `data/recipes.tsv` defines recipes, meal types, servings, seasons, and tags.
- `data/recipe_ingredients.tsv` lists ingredient quantities for each recipe.
- `data/instructions.tsv` contains recipe steps.
- `data/ingredients.tsv` defines categories, package sizes, shelf-life behavior, and piece weights.

## Future Roadmap

If I have more time I want to add:

### Reliability

- [ ] Make unit conversions explicit and ingredient-aware; do not treat grams and milliliters as interchangeable without density data.
- [ ] Add versioned export and import for the complete planner state, with validation and overwrite confirmation.
- [ ] Add automated tests for TSV parsing, conversions, package selection, grocery totals, and optimizer constraints.
- [ ] Validate recipe and ingredient data, and report missing or unsupported values with actionable messages.

### Larger-App Features

- [ ] Add recipe creation and editing with ingredient search, serving scaling, instructions, and data validation.
- [ ] Add shareable grocery lists.
- [ ] Track pantry quantities, freezer stock, and expiration dates to reduce food waste.
- [ ] Somehow take into consideration nutrion
- [ ] Add store-specific package sizes, price tracking, and budget-aware shopping lists.