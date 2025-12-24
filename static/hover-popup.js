document.addEventListener('DOMContentLoaded', function() {
  const hoverElements = document.querySelectorAll('.hover-popup');
  let popupImg = null;

  hoverElements.forEach(function(el) {
    const imgUrl = el.getAttribute('data-img');
    if (!imgUrl) return;

    const maxWidth = el.getAttribute('data-max-width') || '90vw';
    const maxHeight = el.getAttribute('data-max-height') || '90vh';

    el.addEventListener('mouseenter', function(e) {
      // Create popup image if it doesn't exist
      if (!popupImg) {
        popupImg = document.createElement('img');
        popupImg.className = 'hover-popup-img';
        document.body.appendChild(popupImg);
      }

      // Set image source and custom max dimensions
      popupImg.src = imgUrl;
      popupImg.style.maxWidth = maxWidth;
      popupImg.style.maxHeight = maxHeight;

      // Position the popup
      const rect = el.getBoundingClientRect();
      popupImg.style.left = (rect.left + rect.width / 2) + 'px';
      popupImg.style.bottom = (window.innerHeight - rect.top + 20) + 'px';
      popupImg.style.transform = 'translateX(-50%)';

      // Show popup
      setTimeout(() => popupImg.classList.add('show'), 10);
    });

    el.addEventListener('mouseleave', function() {
      if (popupImg) {
        popupImg.classList.remove('show');
      }
    });
  });
});
