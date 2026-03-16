import { ProduceItem } from '../../App'; // Assuming ProduceItem interface is defined in App.tsx

export function getAlternativeSuggestions(
  currentItem: ProduceItem,
  allProduceItems: ProduceItem[],
  highIncreaseThreshold: number = 10 // Default to 10% price increase
): ProduceItem[] {
  // 1. Check if the current item has a high price increase
  if (currentItem.change_percent < highIncreaseThreshold) {
    return []; // No suggestions needed if price increase is not high enough
  }

  // 2. Find similar items (same category) that are cheaper and have a lower or negative change_percent
  const suggestions = allProduceItems.filter(item =>
    item.code !== currentItem.code && // Exclude the current item itself
    item.category === currentItem.category && // Same category
    item.avg_price < currentItem.avg_price && // Cheaper
    item.change_percent <= currentItem.change_percent // Lower or same change_percent (or negative)
  );

  // You might want to sort these suggestions, e.g., by lowest price or lowest change_percent
  return suggestions.sort((a, b) => a.avg_price - b.avg_price); // Sort by cheapest first
}