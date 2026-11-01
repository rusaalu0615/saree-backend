import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const slidesData = [
  {
    image: '/images/festive-linen-palace-banner.jpg',
    category: 'AUTUMN / FESTIVE 2026',
    badge: 'ATELIER ROYAL LINEN',
    title: 'Pure Linen Sarees',
    subtitle: 'DESIGNED TO FLOW • CRAFTED TO IMPRESS',
    description: 'Woven from 100-count certified organic linen with antique gold zari borders. Experience royal heritage drape made for unforgettable celebrations.',
    buttonText: 'EXPLORE COLLECTION',
    link: '/collections/festive',
    secondaryButtonText: 'DISCOVER CRAFT',
    secondaryLink: '/collections',
    layoutStyle: 'editorial-split'
  },
  {
    image: '/images/celebrity-linen-couture-banner.jpg',
    category: 'THE COUTURE EDIT',
    badge: 'SILK MARK CERTIFIED',
    title: 'Celebrity Linen Edit',
    subtitle: 'COLLECTION : PADMINI',
    description: 'Handwoven earthy silhouettes, metallic silver accents, and statement pallus draped for red carpets and grand evenings.',
    buttonText: 'SHOP NOW',
    link: '/collections/celebrity',
    secondaryButtonText: 'VIEW LOOKBOOK',
    secondaryLink: '/video-collection',
    layoutStyle: 'cinematic-canvas'
  },
  {
    image: '/images/festive-sale-heritage-banner.jpg',
    category: 'LIMITED FESTIVE SERIES',
    badge: 'FESTIVE SPLENDOR • UP TO 40% OFF',
    title: 'Artisanal Weaves',
    subtitle: 'TIMELESS HANDLOOM TRADITION',
    description: 'Pure ruby-red and golden mustard drapes spun on traditional shuttle looms. Exceptional festive savings on pure linen heirlooms.',
    buttonText: 'SHOP THE SALE',
    link: '/collections/big-sale',
    secondaryButtonText: 'VIEW ALL SAREES',
    secondaryLink: '/categories/all',
    layoutStyle: 'asymmetric-showcase'
  }
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Hero = mongoose.model('Hero', new mongoose.Schema({ slides: Array }, { strict: false }));
  await Hero.deleteMany({});
  const newHero = await Hero.create({ slides: slidesData });
  console.log('Successfully re-seeded Hero document with 3 authentic real-model linen slides! Total:', newHero.slides.length);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
