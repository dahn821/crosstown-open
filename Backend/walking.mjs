export const walkingPaces={relaxed:1.1,standard:1.35,brisk:1.65};
export function walkingSpeed(preferences){return walkingPaces[preferences.walkingPace??'brisk'];}
