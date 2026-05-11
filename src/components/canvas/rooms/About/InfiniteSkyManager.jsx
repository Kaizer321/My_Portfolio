import { useState, useRef, useMemo, useEffect } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { Text, PositionalAudio } from '@react-three/drei';
import * as THREE from 'three';
import gsap from 'gsap';
import SkyChunk, { CHUNK_LENGTH, ROOM_Z } from './SkyChunk';
import { useScene } from '../../../../context/SceneContext';
import '../../shaders/RevealBasicMaterial'; // Registers brush-stroke reveal for BasicMaterial
import { isTouchDevice } from '../../../../utils/deviceDetect';

// Reusable Vector3 to avoid allocations in event handlers
const _tempVec3 = new THREE.Vector3();

/**
 * InfiniteSkyManager Component
 * 
 * Manages dynamic generation/removal of sky chunks for infinite scroll.
 * World group moves with scroll, chunks stay at fixed positions relative to group.
 * Includes Story Milestones that loop with the content!
 */

import { useAudio } from '../../../../context/AudioManager';
import { getContentByPlatform } from '../Studio/contentData';

export const BALLOON_AUDIO_SETTINGS = {
    volume: 1.0,
    distance: 2,
    rolloff: 2
};

/**
 * Reusable Button Component with Hover Effect + Brush-Stroke Reveal
 */
const AwardButton = ({ onClick, texture, paintedTexture, width, height, position, onHoverChange }) => {
    const isTouch = isTouchDevice();
    const meshRef = useRef();
    const buttonRevealRef = useRef(); // RevealBasicMaterial ref for button sketch
    const paintedRef = useRef(); // Painted button mesh visibility
    const hideDelayRef = useRef(); // Track pending gsap.delayedCall
    const [hovered, setHovered] = useState(false);

    useFrame((state, delta) => {
        if (meshRef.current) {
            // Smoothly lerp scale based on hover state
            const targetScale = hovered ? 1.05 : 1.0;
            const lerpFactor = 10 * delta;

            meshRef.current.scale.x = THREE.MathUtils.lerp(meshRef.current.scale.x, targetScale, lerpFactor);
            meshRef.current.scale.y = THREE.MathUtils.lerp(meshRef.current.scale.y, targetScale, lerpFactor);
            meshRef.current.scale.z = THREE.MathUtils.lerp(meshRef.current.scale.z, targetScale, lerpFactor);
        }
    });

    const handlePointerOver = () => {
        if (isTouch) return;
        setHovered(true);
        document.body.style.cursor = 'pointer';
        onHoverChange?.(true);

        // Brush-stroke reveal button
        if (buttonRevealRef.current) {
            gsap.to(buttonRevealRef.current, {
                uProgress: 1.0,
                duration: 0.8,
                ease: 'power2.out',
                overwrite: true
            });
        }
        if (hideDelayRef.current) hideDelayRef.current.kill();
        if (paintedRef.current) {
            paintedRef.current.visible = true;
            if (paintedRef.current.material) paintedRef.current.material.opacity = 1;
        }
    };

    const handlePointerOut = () => {
        if (isTouch) return;
        setHovered(false);
        document.body.style.cursor = 'auto';
        onHoverChange?.(false);

        // Reverse reveal
        if (buttonRevealRef.current) {
            gsap.to(buttonRevealRef.current, {
                uProgress: 0.0,
                duration: 0.5,
                ease: 'power2.out',
                overwrite: true
            });
        }
        hideDelayRef.current = gsap.delayedCall(0.55, () => {
            if (paintedRef.current && paintedRef.current.material) {
                paintedRef.current.material.opacity = 0;
            }
        });
    };

    return (
        <group ref={meshRef} position={position}>
            {/* Painted button (behind) - hidden until hover */}
            <mesh ref={paintedRef} position={[0, 0, -0.001]} visible={true}>
                <planeGeometry args={[width, height]} />
                <meshBasicMaterial color="#e0e0e0"
                    map={paintedTexture}
                    transparent
                    opacity={0}
                    side={THREE.DoubleSide}
                    alphaTest={0.5}
                    depthWrite={false}
                />
            </mesh>
            {/* Sketch button (front) with reveal */}
            <mesh
                onClick={onClick}
                onPointerOver={handlePointerOver}
                onPointerOut={handlePointerOut}
            >
                <planeGeometry args={[width, height]} />
                <revealBasicMaterial
                    ref={buttonRevealRef}
                    map={texture}
                    transparent
                    side={THREE.DoubleSide}
                    alphaTest={0.1}
                    depthWrite={false}
                    uProgress={0.0}
                />
            </mesh>
            <Text
                position={[0, 0, 0.05]}
                fontSize={0.25}
                color="#1a1a1a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Bold.ttf"
            >
                VIEW
            </Text>
        </group>
    );
};

// Story milestones configuration
// Each milestone appears once per "story cycle" (4 chunks = 160 units)
const STORY_CYCLE_LENGTH = 160;

// === TWARDA LINIA ZANIKANIA DLA MILESTONES (WORLD SPACE) ===
// Pokój About jest na Z = -25, więc -25 to drzwi pokoju
// -27 = 2 metry za drzwiami (w głąb pokoju) - musi matchować CORRIDOR_CLIP_Z w SkyChunk
const MILESTONE_CORRIDOR_CLIP_Z = -8.0;

const InfiniteSkyManager = ({ scrollProgressRef }) => {
    // PRE-CALCULATED FOR scrolProgress = 0
    // currentChunk = floor(0/40) = 0 -> [-1, 0, 1, 2]
    const [activeChunks, setActiveChunks] = useState([-1, 0, 1, 2]);
    // currentStoryCycle = floor(0/160) = 0 -> [-1, 0, 1]
    const [activeStoryCycles, setActiveStoryCycles] = useState([-1, 0, 1]);
    const worldRef = useRef();

    // Track current chunk for recycling
    const getCurrentChunk = (worldZ) => {
        return Math.floor(worldZ / CHUNK_LENGTH);
    };

    // Track current story cycle
    const getCurrentStoryCycle = (worldZ) => {
        return Math.floor(worldZ / STORY_CYCLE_LENGTH);
    };

    // Update chunks based on world position
    useFrame(() => {
        if (!worldRef.current) return;

        const scrollProgress = scrollProgressRef?.current || 0;

        // Move world directly
        worldRef.current.position.z = scrollProgress;

        // Figure out which chunk we're in
        const currentChunk = getCurrentChunk(scrollProgress);
        const shouldBeActiveChunks = [
            currentChunk - 1,
            currentChunk,
            currentChunk + 1,
            currentChunk + 2,
        ];

        const chunksNeedUpdate = shouldBeActiveChunks.some(c => !activeChunks.includes(c)) ||
            activeChunks.some(c => !shouldBeActiveChunks.includes(c));

        if (chunksNeedUpdate) {
            setActiveChunks(shouldBeActiveChunks);
        }

        // Update story cycles
        const currentStoryCycle = getCurrentStoryCycle(scrollProgress);
        const shouldBeActiveCycles = [
            currentStoryCycle - 1,
            currentStoryCycle,
            currentStoryCycle + 1,
        ];

        const cyclesNeedUpdate = shouldBeActiveCycles.some(c => !activeStoryCycles.includes(c)) ||
            activeStoryCycles.some(c => !shouldBeActiveCycles.includes(c));

        if (cyclesNeedUpdate) {
            setActiveStoryCycles(shouldBeActiveCycles);
        }
    });

    return (
        <group ref={worldRef}>
            {/* === SKY CHUNKS WITH CLOUDS === */}
            {activeChunks.map((chunkIndex) => (
                <SkyChunk
                    key={`sky-chunk-${chunkIndex}`}
                    chunkIndex={chunkIndex}
                    seed={42}
                    scrollProgressRef={scrollProgressRef}
                />
            ))}

            {/* === STORY MILESTONES (loop every 160 units) === */}
            {activeStoryCycles.map((cycleIndex) => (
                <group key={`story-cycle-${cycleIndex}`}>
                    {/* === INTRO MILESTONE === */}
                    <IntroMilestone
                        z={-(cycleIndex * STORY_CYCLE_LENGTH + 15)}
                        scrollProgressRef={scrollProgressRef}
                    />

                    {/* === AWARDS MILESTONE === */}
                    <AwardsMilestone
                        z={-(cycleIndex * STORY_CYCLE_LENGTH + 55)}
                        scrollProgressRef={scrollProgressRef}
                    />

                    {/* === JOURNEY MILESTONE === */}
                    <JourneyMilestone
                        z={-(cycleIndex * STORY_CYCLE_LENGTH + 95)}
                        scrollProgressRef={scrollProgressRef}
                    />

                    {/* === SKILLS MILESTONE === */}

                    <SkillsMilestone
                        z={-(cycleIndex * STORY_CYCLE_LENGTH + 135)}
                        scrollProgressRef={scrollProgressRef}
                    />
                </group>
            ))}
        </group>
    );
};

/**
 * INTRO Milestone - Special detailed layout
 * Elements spread apart as they approach camera
 */
const IntroMilestone = ({ z, scrollProgressRef }) => {
    // Load avatar texture
    const avatarTexture = useLoader(THREE.TextureLoader, '/textures/about/awatarnachmurce.webp');
    const { camera, viewport } = useThree();
    const isTouch = isTouchDevice();

    // Refs for all animated elements
    const groupRef = useRef();
    const titleRef = useRef();
    const brandRef = useRef();
    const avatarRef = useRef();
    const motto1Ref = useRef();
    const motto2Ref = useRef();

    // Base positions
    const baseY = 2;

    // Calculate aspect ratio
    // LEGACY FIX: Use original dimensions (2816x1536) to prevent stretching
    const legacyAspectRatio = 2816 / 1536; 
    const avatarWidth = 6; // Zwiększony rozmiar awatara na chmurce
    const avatarHeight = avatarWidth / legacyAspectRatio;

    // Animation: floating + spread apart when close
    useFrame((state) => {
        if (!groupRef.current) return;

        const time = state.clock.elapsedTime;

        // === TWARDA LINIA CLIP (RĘCZNE OBLICZENIE WORLD Z) ===
        // worldZ = pokój(-25) + scrollProgress + lokalna pozycja milestone
        const scrollProgress = scrollProgressRef?.current || 0;
        const worldZ = ROOM_Z + scrollProgress + z;
        groupRef.current.visible = worldZ < MILESTONE_CORRIDOR_CLIP_Z;

        // Skip rest if not visible
        if (!groupRef.current.visible) return;

        // FIX: Use consistent distance based on scrollProgress + offset
        // This ensures animations work IDENTICALLY regardless of chunk/camera position
        // Base Start Z (-15) + Scroll (0) - Offset (55) = -70 (Matches "Working" Chunk 0 feel)
        const distanceZ = z + scrollProgress - 55;

        // Spread effect: starts at z = -25, full spread at z = -5
        // This makes elements spread BEFORE they reach the camera
        // === EDYTUJ TUTAJ (INTRO) ===
        // Zwiększ różnicę między Start a End, żeby animacja była wolniejsza
        const spreadStart = -70; // Startuje wcześniej
        const spreadEnd = -50;   // Kończy później
        let spreadFactor = 0;

        if (distanceZ > spreadStart && distanceZ < spreadEnd) {
            // Calculate spread: 0 at spreadStart, 1 at spreadEnd
            spreadFactor = (distanceZ - spreadStart) / (spreadEnd - spreadStart);
            spreadFactor = Math.min(1, Math.max(0, spreadFactor));
            // Ease out for smoother animation
            spreadFactor = spreadFactor * spreadFactor;
        } else if (distanceZ >= spreadEnd) {
            spreadFactor = 1;
        }

        // Apply spread to elements (move left/right) - MORE AGGRESSIVE
        const maxSpread = 15; // How far elements spread (increased!)

        if (titleRef.current) {
            titleRef.current.position.x = -spreadFactor * maxSpread * 0.8;
        }
        if (brandRef.current) {
            brandRef.current.position.x = spreadFactor * maxSpread * 0.6;
        }
        if (avatarRef.current) {
            // Avatar: floating + spread upward
            avatarRef.current.position.y = baseY + Math.sin(time * 0.8) * 0.15 + spreadFactor * 3;
            avatarRef.current.position.x = -spreadFactor * maxSpread * 0.3;
        }
        if (motto1Ref.current) {
            motto1Ref.current.position.x = spreadFactor * maxSpread * 0.7;
        }
        if (motto2Ref.current) {
            motto2Ref.current.position.x = -spreadFactor * maxSpread * 0.5;
        }
    });

    return (
        <group ref={groupRef} position={[0, 0, z]}>
            {/* Main title - Name (spreads left) */}
            <Text
                ref={titleRef}
                position={[0, 5, 0.1]}
                fontSize={0.8}
                color="#1a1a1a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/RubikScribble-Regular.ttf"
            >
                MUHAMMAD UMAR
            </Text>

            {/* Subtitle - Brand (spreads right) */}
            <Text
                ref={brandRef}
                position={[0, 4.3, 0.1]}
                fontSize={0.45}
                color="#4a4a4a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Regular.ttf"
            >
                (AI Engineer • FAST-NUCES '26)
            </Text>

            {/* Avatar on cloud - floating + spreads up-left */}
            <mesh ref={avatarRef} position={[0, baseY, 0]}>
                <planeGeometry args={[avatarWidth, avatarHeight]} />
                <meshBasicMaterial color="#e0e0e0"
                    map={avatarTexture}
                    transparent
                    side={THREE.DoubleSide}
                    depthWrite={false}
                />
            </mesh>

            {/* Motto - Line 1 (spreads right) */}
            <Text
                ref={motto1Ref}
                position={[0, 0, 0.1]}
                fontSize={0.32}
                color="#555555"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Regular.ttf"
                fontStyle="italic"
            >
                "Building production AI systems —
            </Text>

            {/* Motto - Line 2 (spreads left) */}
            <Text
                ref={motto2Ref}
                position={[0, -0.5, 0]}
                fontSize={0.32}
                color="#555555"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Regular.ttf"
                fontStyle="italic"
            >
                Voice AI, n8n Automation & LLM Agents"
            </Text>
        </group>
    );
};

/**
 * MOCK DATA FOR AWARDS
 */
const AWARDS_DATA = {
    featured: {
        id: 'exp-featured',
        layout: 'certificate_grid',
        title: 'Client Projects',
        items: [
            { label: 'Genius PR — n8n Outreach', date: '2026', image: '/textures/gallery/geniuspr_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'Angelica — Voice AI', date: '2026', image: '/textures/gallery/angelica_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'Gym QA — Call Analysis', date: '2026', image: '/textures/gallery/gymreinforcements_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'Mano Swartz — Voice AI Sales', date: '2025', image: '/textures/gallery/manoswartz_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
        ],
        platformConfig: {
            label: 'WORK',
            color: '#1a1a1a',
            icon: '💼'
        }
    },
    sotd: {
        id: 'exp-techable',
        layout: 'certificate_grid',
        title: 'Techable 360 — AI Intern',
        items: [
            { label: 'N8n automation workflows', date: 'Jun-Aug 2025', image: '/textures/gallery/geniuspr_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'External API integrations', date: 'Jun-Aug 2025', image: '/textures/gallery/angelica_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'Task pipeline optimization', date: 'Jun-Aug 2025', image: '/textures/gallery/gymreinforcements_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
        ],
        platformConfig: {
            label: 'INTERN',
            color: '#1a1a1a',
            icon: '⚡'
        }
    },
    sotm: {
        id: 'exp-empowerbits',
        layout: 'certificate_grid',
        title: 'EmpowerBits — AI Intern',
        items: [
            { label: 'LangChain LLM applications', date: 'May-Aug 2024', image: '/textures/gallery/mcpagent_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'MCP protocol integration', date: 'May-Aug 2024', image: '/textures/gallery/pdfassistant_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
            { label: 'A2A agent coordination', date: 'May-Aug 2024', image: '/textures/gallery/adversaryguard_front.webp', url: 'https://www.linkedin.com/in/muhammad-umer-1bb52326b' },
        ],
        platformConfig: {
            label: 'INTERN',
            color: '#1a1a1a',
            icon: '🤖'
        }
    },
    soty: {
        id: 'exp-freelance',
        layout: 'certificate_grid',
        title: 'Freelance AI Engineer',
        items: [
            { label: 'Voice AI — Retell, Twilio', date: '2025-Present', image: '/textures/gallery/angelica_front.webp', url: 'https://www.upwork.com' },
            { label: 'n8n Automation — HubSpot', date: '2025-Present', image: '/textures/gallery/geniuspr_front.webp', url: 'https://www.upwork.com' },
        ],
        platformConfig: {
            label: 'FREELANCE',
            color: '#1a1a1a',
            icon: '🚀'
        }
    }
};

/**
 * AWARDS Milestone - Floating Cards
 * SOTY (center), SOTD, SOTM, Featured (behind)
 */
const AwardsMilestone = ({ z, scrollProgressRef }) => {
    const { camera, viewport } = useThree();
    const isTouch = isTouchDevice();
    const { openOverlay } = useScene();
    const groupRef = useRef();
    const sotyRef = useRef();
    const sotdRef = useRef();
    const sotmRef = useRef();

    // Card reveal refs (driven by button hover)
    const sotdCardRevealRef = useRef();
    const sotdCardPaintedRef = useRef();
    const sotdHideDelayRef = useRef();
    const sotmCardRevealRef = useRef();
    const sotmCardPaintedRef = useRef();
    const sotmHideDelayRef = useRef();
    const sotyCardRevealRef = useRef();
    const sotyCardPaintedRef = useRef();
    const sotyHideDelayRef = useRef();

    // Load textures
    const sotyTexture = useLoader(THREE.TextureLoader, '/textures/about/SOTY.webp');
    const sotdTexture = useLoader(THREE.TextureLoader, '/textures/about/SOTD.webp');
    const sotmTexture = useLoader(THREE.TextureLoader, '/textures/about/SOTM.webp');
    const sotyPaintedTexture = useLoader(THREE.TextureLoader, isTouch ? '/textures/about/SOTY.webp' : '/textures/about/SOTY_painted.webp');
    const sotdPaintedTexture = useLoader(THREE.TextureLoader, isTouch ? '/textures/about/SOTD.webp' : '/textures/about/SOTD_painted.webp');
    const sotmPaintedTexture = useLoader(THREE.TextureLoader, isTouch ? '/textures/about/SOTM.webp' : '/textures/about/SOTM_painted.webp');
    const buttonTexture = useLoader(THREE.TextureLoader, '/textures/about/button.webp');
    const buttonPaintedTexture = useLoader(THREE.TextureLoader, isTouch ? '/textures/about/button.webp' : '/textures/about/button_painted.webp');

    // Color space fix
    sotyTexture.colorSpace = THREE.SRGBColorSpace;
    sotdTexture.colorSpace = THREE.SRGBColorSpace;
    sotmTexture.colorSpace = THREE.SRGBColorSpace;
    sotyPaintedTexture.colorSpace = THREE.SRGBColorSpace;
    sotdPaintedTexture.colorSpace = THREE.SRGBColorSpace;
    sotmPaintedTexture.colorSpace = THREE.SRGBColorSpace;
    buttonTexture.colorSpace = THREE.SRGBColorSpace;
    buttonPaintedTexture.colorSpace = THREE.SRGBColorSpace;

    // Calculate aspect ratios
    // LEGACY FIX: Use original dimensions for cards (2400x1760) and buttons (894x208)
    const cardLegacyAspect = 2400 / 1760;
    const buttonLegacyAspect = 894 / 208;

    // Base height for cards
    const cardHeight = 2.5;

    // Button dimensions
    const buttonHeight = 0.35;
    const buttonWidth = buttonHeight * buttonLegacyAspect;
    const buttonY = -cardHeight / 2 - buttonHeight / 2 + 0.5;

    // Card hover handler factory
    const makeCardHoverHandler = (revealRef, paintedRef, hideDelayRef) => (isHovered) => {
        if (isTouch) return;
        if (isHovered) {
            if (revealRef.current) {
                gsap.to(revealRef.current, {
                    uProgress: 1.0,
                    duration: 0.8,
                    ease: 'power2.out',
                    overwrite: true
                });
            }
            if (hideDelayRef.current) hideDelayRef.current.kill();
            if (paintedRef.current) {
                paintedRef.current.visible = true;
                if (paintedRef.current.material) paintedRef.current.material.opacity = 1;
            }
        } else {
            if (revealRef.current) {
                gsap.to(revealRef.current, {
                    uProgress: 0.0,
                    duration: 0.5,
                    ease: 'power2.out',
                    overwrite: true
                });
            }
            hideDelayRef.current = gsap.delayedCall(0.55, () => {
                if (paintedRef.current && paintedRef.current.material) {
                    paintedRef.current.material.opacity = 0;
                }
            });
        }
    };

    useFrame((state) => {
        if (!groupRef.current) return;

        const scrollProgress = scrollProgressRef?.current || 0;
        const worldZ = ROOM_Z + scrollProgress + z;
        groupRef.current.visible = worldZ < MILESTONE_CORRIDOR_CLIP_Z;
        if (!groupRef.current.visible) return;

        const distanceZ = z + scrollProgress - 55;

        const revealStart = -120;
        const revealEnd = -50;
        let revealFactor = 0;

        if (distanceZ > revealStart && distanceZ < revealEnd) {
            revealFactor = (distanceZ - revealStart) / (revealEnd - revealStart);
            revealFactor = Math.min(1, Math.max(0, revealFactor));
            revealFactor = revealFactor * revealFactor;
        } else if (distanceZ >= revealEnd) {
            revealFactor = 1;
        }

        const sotyStart = -80;
        const sotyEnd = -20;
        let sotyFactor = 0;

        if (distanceZ > sotyStart && distanceZ < sotyEnd) {
            sotyFactor = (distanceZ - sotyStart) / (sotyEnd - sotyStart);
            sotyFactor = Math.min(1, Math.max(0, sotyFactor));
            sotyFactor = 1 - Math.pow(1 - sotyFactor, 2);
        } else if (distanceZ >= sotyEnd) {
            sotyFactor = 1;
        }

        const spreadX = 5;

        if (sotdRef.current) {
            sotdRef.current.position.x = -revealFactor * spreadX;
        }
        if (sotmRef.current) {
            sotmRef.current.position.x = revealFactor * spreadX;
        }

        if (sotyRef.current) {
            sotyRef.current.position.y = 0.5 + sotyFactor * 2.5;
        }
    });

    return (
        <group ref={groupRef} position={[0, 2, z]}>
            {/* Title */}
            <Text
                position={[0, 4, 0]}
                fontSize={1.2}
                color="#1a1a1a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/RubikScribble-Regular.ttf"
            >
                EXPERIENCE
            </Text>

            {/* === SOTD (behind SOTY, rendered second) === */}
            <group ref={sotdRef} position={[0, 0.5, -0.5]}>
                {/* Painted card (behind) - hidden until button hover */}
                <mesh ref={sotdCardPaintedRef} position={[0, 0, -0.001]} visible={true}>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <meshBasicMaterial color="#e0e0e0"
                        map={sotdPaintedTexture}
                        transparent
                        opacity={0}
                        side={THREE.DoubleSide}
                        alphaTest={0.5}
                    />
                </mesh>
                {/* Sketch card (front) with reveal */}
                <mesh>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <revealBasicMaterial
                        ref={sotdCardRevealRef}
                        map={sotdTexture}
                        transparent
                        side={THREE.DoubleSide}
                        uProgress={0.0}
                    />
                </mesh>
                {/* BUTTON */}
                <AwardButton
                    onClick={(e) => {
                        e.stopPropagation();
                        openOverlay(AWARDS_DATA.sotd);
                    }}
                    texture={buttonTexture}
                    paintedTexture={buttonPaintedTexture}
                    width={buttonWidth}
                    height={buttonHeight}
                    position={[0, buttonY, 0.05]}
                    onHoverChange={makeCardHoverHandler(sotdCardRevealRef, sotdCardPaintedRef, sotdHideDelayRef)}
                />
                {/* AWARD LABEL */}
                <Text
                    position={[0, 0.95, 0.01]}
                    fontSize={0.45}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    TECHABLE 360
                </Text>
                {/* AWARD COUNT */}
                <Text
                    position={[-0.05, 0, 0.01]}
                    fontSize={0.8}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    2025
                </Text>
            </group>

            {/* === SOTM (behind SOTY, rendered third) === */}
            <group ref={sotmRef} position={[0, 0.5, -0.2]}>
                {/* Painted card (behind) - hidden until button hover */}
                <mesh ref={sotmCardPaintedRef} position={[0, 0, -0.001]} visible={true}>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <meshBasicMaterial color="#e0e0e0"
                        map={sotmPaintedTexture}
                        transparent
                        opacity={0}
                        side={THREE.DoubleSide}
                        alphaTest={0.5}
                    />
                </mesh>
                {/* Sketch card (front) with reveal */}
                <mesh>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <revealBasicMaterial
                        ref={sotmCardRevealRef}
                        map={sotmTexture}
                        transparent
                        side={THREE.DoubleSide}
                        uProgress={0.0}
                    />
                </mesh>
                {/* BUTTON */}
                <AwardButton
                    onClick={(e) => {
                        e.stopPropagation();
                        openOverlay(AWARDS_DATA.sotm);
                    }}
                    texture={buttonTexture}
                    paintedTexture={buttonPaintedTexture}
                    width={buttonWidth}
                    height={buttonHeight}
                    position={[0, buttonY, 0.05]}
                    onHoverChange={makeCardHoverHandler(sotmCardRevealRef, sotmCardPaintedRef, sotmHideDelayRef)}
                />
                {/* AWARD LABEL */}
                <Text
                    position={[0, 0.95, 0.01]}
                    fontSize={0.45}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    EMPOWERBITS
                </Text>
                {/* AWARD COUNT */}
                <Text
                    position={[-0.05, 0, 0.01]}
                    fontSize={0.8}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    2024
                </Text>
            </group>

            {/* === SOTY (front, center, rendered LAST = always on top) === */}
            <group ref={sotyRef} position={[0, 0.5, 0]}>
                {/* Painted card (behind) - hidden until button hover */}
                <mesh ref={sotyCardPaintedRef} position={[0, 0, -0.001]} visible={true}>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <meshBasicMaterial color="#e0e0e0"
                        map={sotyPaintedTexture}
                        transparent
                        opacity={0}
                        side={THREE.DoubleSide}
                        alphaTest={0.5}
                    />
                </mesh>
                {/* Sketch card (front) with reveal */}
                <mesh>
                    <planeGeometry args={[cardHeight * cardLegacyAspect, cardHeight]} />
                    <revealBasicMaterial
                        ref={sotyCardRevealRef}
                        map={sotyTexture}
                        transparent
                        side={THREE.DoubleSide}
                    />
                </mesh>
                {/* BUTTON */}
                <AwardButton
                    onClick={(e) => {
                        e.stopPropagation();
                        openOverlay(AWARDS_DATA.soty);
                    }}
                    texture={buttonTexture}
                    paintedTexture={buttonPaintedTexture}
                    width={buttonWidth}
                    height={buttonHeight}
                    position={[0, buttonY, 0.05]}
                    onHoverChange={makeCardHoverHandler(sotyCardRevealRef, sotyCardPaintedRef, sotyHideDelayRef)}
                />
                {/* AWARD LABEL */}
                <Text
                    position={[0, 0.95, 0.01]}
                    fontSize={0.45}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    FREELANCE
                </Text>
                {/* AWARD COUNT */}
                <Text
                    position={[-0.05, 0, 0.01]}
                    fontSize={0.8}
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    NOW
                </Text>
            </group>
        </group>
    );
};

/**
 * JOURNEY Milestone - Floating Islands
 * UO Island (left) and Freelance Island (right) floating in clouds
 */
const JourneyMilestone = ({ z, scrollProgressRef }) => {
    const { camera, viewport } = useThree();
    const isTouch = isTouchDevice();
    const groupRef = useRef();
    const uoRef = useRef();
    const freelanceRef = useRef();

    // Load textures
    const uoTexture = useLoader(THREE.TextureLoader, '/textures/about/uowyspa.webp');
    const freelanceTexture = useLoader(THREE.TextureLoader, '/textures/about/freelancewyspa.webp');

    // Texture settings
    uoTexture.colorSpace = THREE.SRGBColorSpace;
    freelanceTexture.colorSpace = THREE.SRGBColorSpace;

    // Calculate aspect ratios to keep images 1:1 (not stretched)
    // LEGACY FIX: Use original dimensions (2816x1536)
    const islandLegacyAspect = 2816 / 1536;
    const uoAspect = islandLegacyAspect;
    const freelanceAspect = islandLegacyAspect;

    // Base height for islands - width will adjust automatically
    const islandHeight = 4.5;

    useFrame((state) => {
        if (!groupRef.current) return;

        // === TWARDA LINIA CLIP (RĘCZNE OBLICZENIE WORLD Z) ===
        const scrollProgress = scrollProgressRef?.current || 0;
        const worldZ = ROOM_Z + scrollProgress + z;
        groupRef.current.visible = worldZ < MILESTONE_CORRIDOR_CLIP_Z;
        if (!groupRef.current.visible) return;

        const time = state.clock.elapsedTime;

        // FIX: Use consistent distance based on scrollProgress + offset
        const distanceZ = z + scrollProgress - 55;

        // Reveal effect (islands float up from below clouds)
        // === EDYTUJ TUTAJ (JOURNEY) ===
        const revealStart = -100; // Wcześniejszy start
        const revealEnd = -20;
        let revealFactor = 0;

        if (distanceZ > revealStart && distanceZ < revealEnd) {
            revealFactor = (distanceZ - revealStart) / (revealEnd - revealStart);
            revealFactor = Math.min(1, Math.max(0, revealFactor));
            revealFactor = 1 - Math.pow(1 - revealFactor, 2);
        } else if (distanceZ >= revealEnd) {
            revealFactor = 1;
        }

        // Floating animation (bobbing)
        // UO Island (Left)
        if (uoRef.current) {
            // === EDYTUJ POZYCJE TUTAJ (UO) ===
            const startY = -2;
            const endY = 1.5;

            const currentBaseY = startY + revealFactor * (endY - startY);
            uoRef.current.position.y = currentBaseY + Math.sin(time * 0.5) * 0.2;
            uoRef.current.rotation.z = Math.sin(time * 0.3) * 0.05;
        }

        // Freelance Island (Right)
        if (freelanceRef.current) {
            // === EDYTUJ POZYCJE TUTAJ (Freelance) ===
            const startY = -1;
            const endY = 2.5;

            const currentBaseY = startY + revealFactor * (endY - startY);
            freelanceRef.current.position.y = currentBaseY + Math.sin(time * 0.4 + 2) * 0.25;
            freelanceRef.current.rotation.z = Math.sin(time * 0.2 + 1) * -0.05;
        }
    });

    return (
        <group ref={groupRef} position={[0, 0, z]}>
            {/* Title */}
            <Text
                position={[0, 5, 0.3]}
                fontSize={1.2}
                color="#1a1a1a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/RubikScribble-Regular.ttf"
            >
                EDUCATION
            </Text>

            {/* Subtitle */}
            <Text
                position={[0, 4.2, 0.3]}
                fontSize={0.35}
                color="#555555"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Regular.ttf"
            >
                Where I learned...
            </Text>

            {/* === UO ISLAND (Left) === */}
            <group ref={uoRef} position={[-3.5, -1, 0]}>
                <mesh>
                    <planeGeometry args={[islandHeight * uoAspect, islandHeight]} />
                    <meshBasicMaterial color="#e0e0e0"
                        map={uoTexture}
                        transparent
                        side={THREE.DoubleSide}
                    />
                </mesh>
                {/* NAPIS NA WYSPIE (UO) - EDYTUJ TUTAJ */}
                <Text
                    position={[0.1, -0.85, 0.1]} // POZYCJA (X, Y, Z)
                    fontSize={0.4}           // WIELKOŚĆ
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    BS AI
                </Text>
            </group>

            {/* === FREELANCE ISLAND (Right) === */}
            <group ref={freelanceRef} position={[3.5, -2, 0.5]}>
                <mesh>
                    <planeGeometry args={[islandHeight * freelanceAspect, islandHeight]} />
                    <meshBasicMaterial color="#e0e0e0"
                        map={freelanceTexture}
                        transparent
                        side={THREE.DoubleSide}
                    />
                </mesh>
                {/* NAPIS NA WYSPIE (Freelance) - EDYTUJ TUTAJ */}
                <Text
                    position={[0, -0.65, 0.1]} // POZYCJA (X, Y, Z)
                    fontSize={0.5}           // WIELKOŚĆ
                    color="#1a1a1a"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                >
                    FSc (Pre-Eng)
                </Text>
            </group>
        </group>
    );
};

/**
 * SKILLS Milestone - Floating Balloons
 * Colorful balloons floating upward, each representing a skill
 */

// Build BALLOON_CONFIG dynamically from Studio 'skills' content
// This ensures balloons match the Studio tab entries and use their front textures as icons.
const buildBalloonConfigFromStudio = () => {
    const skills = getContentByPlatform('skills');
    // fallback positions (spread across area) - will be reused per index
    const presetPositions = [
        { x: -7.5, y: 4.6, z: 0.4, phase: 0.0 },
        { x: -2.5, y: 5.0, z: 0.2, phase: 1.2 },
        { x: 2.5, y: 4.7, z: 0.5, phase: 2.4 },
        { x: 7.5, y: 5.1, z: 0.1, phase: 3.6 },
        { x: -6.8, y: 2.7, z: -0.2, phase: 0.7 },
        { x: -2.0, y: 2.9, z: -0.3, phase: 1.9 },
        { x: 2.0, y: 2.6, z: -0.1, phase: 3.1 },
        { x: 6.8, y: 2.8, z: -0.4, phase: 4.3 },
        { x: -5.5, y: 0.8, z: -0.6, phase: 0.5 },
        { x: -1.0, y: 1.1, z: -0.7, phase: 1.7 },
        { x: 3.5, y: 0.9, z: -0.5, phase: 2.9 },
        { x: 7.0, y: 1.2, z: -0.8, phase: 4.1 },
    ];

    return skills.map((item, idx) => {
        const pos = presetPositions[idx % presetPositions.length];
        return {
            label: item.title,
            size: 'medium',
            x: pos.x,
            y: pos.y,
            z: pos.z,
            phase: pos.phase,
        };
    });
};

const BALLOON_CONFIG = buildBalloonConfigFromStudio();

// Size multipliers for balloon categories
const SIZE_MULTIPLIERS = {
    large: 3.0,
    medium: 2.2,
    small: 1.6,
};

// Individual cloud component
const SkillBalloon = ({ config, revealFactorRef, spreadFactorRef, timeRef }) => {
    const { camera } = useThree();
    const isTouch = isTouchDevice();
    const [hovered, setHovered] = useState(false);
    const outerGroupRef = useRef();
    const innerGroupRef = useRef();
    const textRef = useRef();
    const targetScale = useRef(1.0);
    const currentScale = useRef(1.0);

    const baseHeight = SIZE_MULTIPLIERS[config.size];
    const positionScale = isTouch ? 0.5 : 1;
    const spreadScale = isTouch ? 0.4 : 1;
    const sizeScale = isTouch ? 0.92 : 1;

    const cloudPuffs = useMemo(() => {
        return [
            { x: -1.1, y: -0.05, r: 0.58 },
            { x: -0.62, y: 0.22, r: 0.76 },
            { x: -0.05, y: 0.34, r: 0.95 },
            { x: 0.58, y: 0.24, r: 0.84 },
            { x: 1.14, y: -0.02, r: 0.62 },
            { x: -0.38, y: -0.22, r: 0.78 },
            { x: 0.28, y: -0.2, r: 0.88 },
        ];
    }, []);

    useEffect(() => {
        document.body.style.cursor = hovered ? 'pointer' : 'auto';
    }, [hovered]);

    useFrame((state, delta) => {
        if (!outerGroupRef.current) return;

        const time = timeRef.current;
        const revealFactor = revealFactorRef.current;
        const spreadFactor = spreadFactorRef.current;

        const floatY = Math.sin(time * 0.6 + config.phase) * 0.3;
        const floatX = Math.sin(time * 0.4 + config.phase * 0.7) * 0.12;

        const startY = config.y - 8;
        const endY = config.y;
        const currentY = startY + revealFactor * (endY - startY) + floatY;

        targetScale.current = hovered ? 1.06 : 1.0;
        currentScale.current = THREE.MathUtils.lerp(currentScale.current, targetScale.current, 8 * delta);

        const maxSpread = 15 * spreadScale;
        let spreadX = 0;

        if (config.x < -0.5) {
            spreadX = -spreadFactor * maxSpread * (0.5 + Math.abs(config.x) / 6);
        } else if (config.x > 0.5) {
            spreadX = spreadFactor * maxSpread * (0.5 + Math.abs(config.x) / 6);
        } else {
            spreadX = config.phase > 3.5
                ? spreadFactor * maxSpread * 0.8
                : -spreadFactor * maxSpread * 0.8;
        }

        const baseX = config.x * positionScale;
        const scale = Math.max(0.001, revealFactor * sizeScale * currentScale.current);

        outerGroupRef.current.position.set(baseX + floatX + spreadX, currentY, config.z);
        outerGroupRef.current.scale.set(scale, scale, scale);
        outerGroupRef.current.lookAt(camera.position);

        if (textRef.current) {
            textRef.current.quaternion.copy(camera.quaternion);
        }
    });

    return (
        <group ref={outerGroupRef} position={[config.x * positionScale, config.y - 8, config.z]}>
            <group ref={innerGroupRef}>
                {/* Soft shadow */}
                <mesh position={[0.08, -0.09, -0.02]}>
                    <circleGeometry args={[Math.max(0.4, baseHeight * 0.72), 64]} />
                    <meshBasicMaterial color="#000000" transparent opacity={0.08} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>

                {/* Cloud body */}
                <group>
                    {cloudPuffs.map((puff, index) => (
                        <group key={index} position={[puff.x * baseHeight, puff.y * baseHeight, puff.r * 0.01]}>
                            <mesh scale={[1.08, 1.08, 1]}>
                                <circleGeometry args={[puff.r * baseHeight * 0.62, 48]} />
                                <meshBasicMaterial color="#2d2d2d" transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
                            </mesh>
                            <mesh position={[0, 0, -0.02]}>
                            <circleGeometry args={[puff.r * baseHeight * 0.62, 48]} />
                            <meshStandardMaterial
                                color={index === 2 ? '#ffffff' : '#f4f4f2'}
                                transparent
                                opacity={0.98}
                                side={THREE.DoubleSide}
                                roughness={0.98}
                                metalness={0.0}
                                depthWrite={false}
                            />
                            </mesh>
                        </group>
                    ))}
                </group>

                {/* Outline */}
                <mesh>
                    <circleGeometry args={[Math.max(0.4, baseHeight * 1.0), 64]} />
                    <meshBasicMaterial color="#1f1f1f" transparent opacity={0.14} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>

                {/* Skill label inside cloud */}
                <Text
                    ref={textRef}
                    position={[0, 0.02, 0.28]}
                    fontSize={baseHeight * 0.18}
                    color="#ffffff"
                    anchorX="center"
                    anchorY="middle"
                    font="/fonts/CabinSketch-Bold.ttf"
                    renderOrder={20}
                    fillOpacity={1}
                    outlineWidth={0.045}
                    outlineColor="#1a1a1a"
                    outlineOpacity={1}
                >
                    {config.label}
                </Text>
            </group>
        </group>
    );
};

const SkillsMilestone = ({ z, scrollProgressRef }) => {
    const { camera, viewport } = useThree();
    const isTouch = isTouchDevice();
    const groupRef = useRef();
    // P2: Use refs instead of state to avoid 60 re-renders/sec inside useFrame
    const revealFactorRef = useRef(0);
    const spreadFactorRef = useRef(0);
    const timeRef = useRef(0);

    useFrame((state) => {
        if (!groupRef.current) return;

        // === TWARDA LINIA CLIP (RĘCZNE OBLICZENIE WORLD Z) ===
        const scrollProgress = scrollProgressRef?.current || 0;
        const worldZ = ROOM_Z + scrollProgress + z;
        groupRef.current.visible = worldZ < MILESTONE_CORRIDOR_CLIP_Z;
        if (!groupRef.current.visible) return;

        timeRef.current = state.clock.elapsedTime;

        // FIX: Use consistent distance based on scrollProgress + offset
        const distanceZ = z + scrollProgress - 55;

        // Reveal effect (balloons float up)
        // === EDYTUJ TUTAJ (SKILLS REVEAL) ===
        const revealStart = -100;
        const revealEnd = -25;
        let newRevealFactor = 0;

        if (distanceZ > revealStart && distanceZ < revealEnd) {
            newRevealFactor = (distanceZ - revealStart) / (revealEnd - revealStart);
            newRevealFactor = Math.min(1, Math.max(0, newRevealFactor));
            newRevealFactor = 1 - Math.pow(1 - newRevealFactor, 3); // ease out cubic
        } else if (distanceZ >= revealEnd) {
            newRevealFactor = 1;
        }

        revealFactorRef.current = newRevealFactor;

        // === SPREAD EFFECT (EDYTUJ TUTAJ SKILLS SPREAD) ===
        // Im bliżej kamery, tym bardziej balony się rozsuwają
        // Większy zakres = dłuższa, bardziej widoczna animacja
        const spreadStart = -70; // Kiedy animacja SIĘ ZACZYNA (Wcześniej)
        const spreadEnd = -40;    // Kiedy animacja jest PEŁNA (Później)
        let newSpreadFactor = 0;

        if (distanceZ > spreadStart && distanceZ < spreadEnd) {
            newSpreadFactor = (distanceZ - spreadStart) / (spreadEnd - spreadStart);
            newSpreadFactor = Math.min(1, Math.max(0, newSpreadFactor));
            newSpreadFactor = newSpreadFactor * newSpreadFactor; // ease in
        } else if (distanceZ >= spreadEnd) {
            newSpreadFactor = 1;
        }

        spreadFactorRef.current = newSpreadFactor;
    });

    return (
        <group ref={groupRef} position={[0, 0, z]}>
            {/* Title */}
            <Text
                position={[0, 6, 0.5]}
                fontSize={1.2}
                color="#1a1a1a"
                anchorX="center"
                anchorY="middle"
                font="/fonts/RubikScribble-Regular.ttf"
            >
                SKILLS
            </Text>

            {/* Subtitle */}
            <Text
                position={[0, 5.2, 0.5]}
                fontSize={0.35}
                color="#555555"
                anchorX="center"
                anchorY="middle"
                font="/fonts/CabinSketch-Regular.ttf"
            >
                Technologies I love working with
            </Text>

            {/* === FLOATING BALLOONS === */}
            {BALLOON_CONFIG.map((config, index) => (
                <SkillBalloon
                    key={index}
                    config={config}
                    revealFactorRef={revealFactorRef}
                    spreadFactorRef={spreadFactorRef}
                    timeRef={timeRef}
                />
            ))}
        </group>
    );
};

// =========================================
// NOTE: Use this component inside the loop!
// =========================================

export default InfiniteSkyManager;
