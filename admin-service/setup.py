"""
Setup para instalação global do CLI Admin Experience Connect.

Uso:
    pip install -e .  # Modo desenvolvimento (editável)
    pip install .     # Instalação permanente
"""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="cxgame-admin-cli",
    version="1.0.0",
    author="Experience Connect Team",
    description="CLI Admin para gerenciamento do backend Experience Connect",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/ryanlcruz/Experiencie-Connect",
    py_modules=["cli"],
    install_requires=[
        "click>=8.1.7",
        "requests>=2.31.0",
        "python-dotenv>=1.0.0",
    ],
    entry_points={
        "console_scripts": [
            "cxgame-admin=cli:cli",
        ],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Build Tools",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
    python_requires=">=3.11",
)
