import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const slidesData = [
  {
    image: '/images/festive-collection-hero.jpg',
    category: 'AUTUMN / FESTIVE 2026',
    badge: 'ATELIER HANDLOOM',
    title: 'The Poetry of Pure Linen & Zari',
    subtitle: 'Woven by master artisans across Bengal & Banaras looms',
    description: 'Experience the effortless luxury of 100-count organic linen interwoven with delicate antique gold zari. Breathable drape meets royal heritage.',
    buttonText: 'EXPLORE ATELIER',
    link: '/collections/festive',
    secondaryButtonText: 'DISCOVER HERITAGE',
    secondaryLink: '/collections',
    layoutStyle: 'editorial-split'
  },
  {
    image: '/images/celebrity-star-banner.jpg',
    category: 'THE COUTURE EDIT',
    badge: 'CELEBRITY RED CARPET',
    title: 'Drama in Every Drape',
    subtitle: "Cinematic sarees tailored for life's grandest stages",
    description: 'Adorned by cultural icons and draped under spotlight glow. A modern interpretation of ancient textile art, crafted with immaculate precision.',
    buttonText: 'VIEW RED CARPET EDIT',
    link: '/collections/celebrity',
    secondaryButtonText: 'WATCH LOOKBOOK',
    secondaryLink: '/video-collection',
    layoutStyle: 'cinematic-canvas'
  },
  {
    image: '/images/big-sale-banner.jpg',
    category: 'LIMITED SERIES',
    badge: 'EXCLUSIVE CURATION',
    title: 'Artisanal Silence & Gold',
    subtitle: 'Where timeless handloom tradition meets modern silhouette',
    description: 'Natural dyes, hand-spun weft, and subtle tissue borders. Discover our exclusive festive curation and rare archival drapes.',
    buttonText: 'SHOP THE COLLECTION',
    link: '/collections/big-sale',
    secondaryButtonText: 'EXPLORE ALL SAREES',
    secondaryLink: '/categories/all',
    layoutStyle: 'asymmetric-showcase'
  }
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Hero = mongoose.model('Hero', new mongoose.Schema({ slides: Array }, { strict: false }));
  await Hero.deleteMany({});
  const newHero = await Hero.create({ slides: slidesData });
  console.log('Successfully initialized Hero document with 3 luxury slides! Total slides:', newHero.slides.length);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
