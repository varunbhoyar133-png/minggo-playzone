document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const hamburger = document.getElementById('hamburger');
    const mobileNav = document.getElementById('mobile-nav');
    const mobileLinks = document.querySelectorAll('.mobile-link');
    
    const slotsContainer = document.getElementById('slots-container');
    const slotsLoading = document.getElementById('slots-loading');
    const dateInput = document.getElementById('booking-date');
    const pricingInfo = document.getElementById('pricing-info');
    
    // Modal
    const modal = document.getElementById('booking-modal');
    const closeModal = document.getElementById('close-modal');
    const bookingForm = document.getElementById('booking-form');
    
    const modalDateText = document.getElementById('modal-date-text');
    const modalTimeText = document.getElementById('modal-time-text');
    const modalPriceText = document.getElementById('modal-price-text');
    const slotTimeInput = document.getElementById('booking-slot-time');
    const childrenCountInput = document.getElementById('children-count');
    
    const submitBtn = document.getElementById('submit-booking-btn');
    const successMsg = document.getElementById('success-message');
    const errorMsg = document.getElementById('error-message');
    const whatsappShareBtn = document.getElementById('whatsapp-share');

    const API_URL = '/api';
    let currentPrice = 0;

    // Set Default Date to Today
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
    dateInput.min = today; // restrict past dates

    // Toggle Mobile Nav
    hamburger.addEventListener('click', () => {
        mobileNav.classList.toggle('active');
    });

    mobileLinks.forEach(link => {
        link.addEventListener('click', () => {
            mobileNav.classList.remove('active');
        });
    });

    dateInput.addEventListener('change', () => {
        loadPrice();
        loadSlots();
    });

    async function loadPrice() {
        try {
            const date = dateInput.value || today;
            const res = await fetch(`${API_URL}/price?date=${date}`);
            const data = await res.json();
            currentPrice = data.price;
            
            const isWeekend = currentPrice === 300;
            pricingInfo.textContent = `Current Price: ₹${currentPrice} per child (${isWeekend ? 'Weekend' : 'Weekday'})`;
        } catch(e) {
            pricingInfo.textContent = 'Failed to load pricing.';
        }
    }

    function updateModalTotal() {
        const childrenCount = Number.parseInt(childrenCountInput.value, 10) || 1;
        const totalAmount = currentPrice * childrenCount;
        modalPriceText.textContent = `Total: ₹${totalAmount}.00`;
    }

    // Fetch and render slots
    async function loadSlots() {
        slotsContainer.innerHTML = '';
        slotsLoading.style.display = 'block';
        slotsLoading.textContent = 'Loading available slots...';

        try {
            const date = dateInput.value || today;
            const response = await fetch(`${API_URL}/slots?date=${date}`);
            const slots = await response.json();
            
            slotsLoading.style.display = 'none';

            slots.forEach(slot => {
                const slotEl = document.createElement('div');
                slotEl.className = 'slot-card';
                slotEl.textContent = slot.time;
                slotEl.addEventListener('click', () => openBookingModal(slot));
                slotsContainer.appendChild(slotEl);
            });
        } catch (error) {
            slotsLoading.textContent = 'Error loading slots. Please try again later.';
            console.error('Error fetching slots:', error);
        }
    }

    // Modal Logic
    function openBookingModal(slot) {
        modalDateText.textContent = dateInput.value || today;
        modalTimeText.textContent = slot.time;
        slotTimeInput.value = slot.time;
        
        bookingForm.reset();
        childrenCountInput.value = 1;
        updateModalTotal();
        bookingForm.style.display = 'block';
        successMsg.style.display = 'none';
        errorMsg.style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Pay & Book Now';
        
        modal.classList.add('active');
    }

    closeModal.addEventListener('click', () => {
        modal.classList.remove('active');
    });
    childrenCountInput.addEventListener('input', updateModalTotal);

    // Handle Form Submit & Razorpay
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        submitBtn.disabled = true;
        submitBtn.textContent = 'Initializing Payment...';
        errorMsg.style.display = 'none';

        const parentName = document.getElementById('parent-name').value;
        const parentPhone = document.getElementById('parent-phone').value;
        const childrenCount = Number.parseInt(document.getElementById('children-count').value, 10);
        const date = dateInput.value || today;
        const time = slotTimeInput.value;

        if (Number.isNaN(childrenCount) || childrenCount < 1 || childrenCount > 20) {
            showError('Please enter children count between 1 and 20.');
            submitBtn.disabled = false;
            return;
        }

        try {
            // 1. Create Order
            const orderRes = await fetch(`${API_URL}/book/order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date,
                    time,
                    name: parentName,
                    phone: parentPhone,
                    children_count: childrenCount
                })
            });

            const orderData = await orderRes.json();

            if (!orderRes.ok) {
                throw new Error(orderData.error || 'Failed to create order');
            }

            // 2. Open Razorpay Checkout
            const options = {
                key: orderData.key_id,
                amount: orderData.amount * 100, // paise
                currency: "INR",
                name: "Minggo Playzone",
                description: `Booking for ${date} at ${time}`,
                order_id: orderData.order_id,
                prefill: { name: parentName, contact: parentPhone },
                theme: { color: "#EF476F" },
                handler: async function (response) {
                    // 3. Verify Payment
                    submitBtn.textContent = 'Verifying...';
                    try {
                        const verifyRes = await fetch(`${API_URL}/book/verify`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_signature: response.razorpay_signature
                            })
                        });

                        const verifyData = await verifyRes.json();

                        if (verifyRes.ok) {
                            // Display Success
                            bookingForm.style.display = 'none';
                            successMsg.style.display = 'block';
                            
                            // Prep WhatsApp Share
                            const msg = `Hi Minggo Playzone! 🎉\nI just booked a slot.\n\n*Name:* ${parentName}\n*Date:* ${date}\n*Time:* ${time}\n*Children:* ${childrenCount}\n\nCan't wait!`;
                            whatsappShareBtn.href = `https://wa.me/1234567890?text=${encodeURIComponent(msg)}`;

                            loadSlots(); // Refresh UI
                        } else {
                            throw new Error(verifyData.error || 'Payment verification failed');
                        }
                    } catch (err) {
                        showError(err.message);
                    }
                }
            };

            const rzp = new Razorpay(options);
            rzp.on('payment.failed', function (response){
                showError('Payment failed or cancelled.');
            });
            rzp.open();
            
            // Allow them to click again if they closed it
            submitBtn.textContent = 'Reopen Payment';
            submitBtn.disabled = false;

        } catch (error) {
            showError(error.message);
        }
    });

    function showError(Text) {
        errorMsg.textContent = Text;
        errorMsg.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Pay & Book Now';
    }

    // Initial Load
    loadPrice();
    loadSlots();

    // Intersection Observer for Scroll Animations
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.15
    };

    const scrollObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const fadeElements = document.querySelectorAll('.fade-up, .zoom-in');
    fadeElements.forEach(el => {
        scrollObserver.observe(el);
    });
});
