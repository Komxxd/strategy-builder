import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}

export const EXCHANGE_TYPE_MAP = {
    'NSE': 1,
    'NFO': 2,
    'BSE': 3,
    'BFO': 4,
    'MCX': 5,
};
