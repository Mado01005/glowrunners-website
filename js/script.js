document.addEventListener('DOMContentLoaded', () => {
  // Intersection Observer for Scroll Animations
  const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.15
  };

  const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
      }
    });
  }, observerOptions);

  const revealElements = document.querySelectorAll('.reveal-up');
  revealElements.forEach(el => scrollObserver.observe(el));

  // --- Navbar Scroll Logic ---
  const navbar = document.querySelector('.navbar');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      navbar.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.05)';
      navbar.style.padding = '0.75rem 5vw';
    } else {
      navbar.style.boxShadow = 'none';
      navbar.style.padding = '1rem 5vw';
    }
  });

  // --- Dynamic Text Engine with Specific Color Logic ---
  const rotatingWords = [
    { text: "Energy", cssClass: "text-coral" },
    { text: "Glowrunners", cssClass: "text-gradient" }
  ];
  
  let currentWordIndex = 0;
  const rotatingContainer = document.querySelector('.rotating-text-container');
  
  if (rotatingContainer) {
    setInterval(() => {
      currentWordIndex = (currentWordIndex + 1) % rotatingWords.length;
      const currentWordObj = rotatingWords[currentWordIndex];
      
      // Flush the container
      rotatingContainer.innerHTML = '';
      
      // Inject new word with appropriate CSS classes
      const newElement = document.createElement('span');
      // combine animation class and the target color class defined in CSS
      newElement.className = `rotating-text ${currentWordObj.cssClass}`;
      newElement.textContent = currentWordObj.text;
      
      rotatingContainer.appendChild(newElement);
    }, 2500);
  }
});
